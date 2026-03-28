import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

import requests as http_requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
logger = logging.getLogger(__name__)


def _parse_iso8601_duration(duration: str) -> Optional[int]:
    """Parse ISO 8601 duration string (e.g. 'PT5M4S') to total seconds."""
    if not duration:
        return None
    match = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$", duration)
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(float(match.group(3) or 0))
    return hours * 3600 + minutes * 60 + seconds


class YouTubeService:
    def __init__(
        self, client_secrets_path: str = "client_secret.json", token_path: str = "token.json"
    ):
        logger.debug(
            "Initializing YouTubeService client_secrets_path=%s token_path=%s",
            client_secrets_path,
            token_path,
        )
        self.client_secrets_path = client_secrets_path
        self.token_path = token_path
        self.credentials = self._get_credentials()
        self.youtube = build("youtube", "v3", credentials=self.credentials)
        logger.debug("YouTube API client initialized")

    @classmethod
    def from_credentials(cls, credentials: Credentials) -> "YouTubeService":
        """Create a YouTubeService from existing credentials without an OAuth flow.
        Each call to build() creates independent HTTP objects, making this thread-safe."""
        instance = cls.__new__(cls)
        instance.credentials = credentials
        instance.youtube = build("youtube", "v3", credentials=credentials)
        logger.debug("Created YouTubeService from existing credentials")
        return instance

    def _get_credentials(self) -> Credentials:
        logger.debug("Resolving YouTube credentials")
        credentials = None

        if os.path.exists(self.token_path):
            logger.debug("Loading cached credentials from %s", self.token_path)
            credentials = Credentials.from_authorized_user_file(self.token_path, SCOPES)

        if not credentials or not credentials.valid:
            logger.debug("Credentials missing or invalid; refreshing or running OAuth flow")
            if credentials and credentials.expired and credentials.refresh_token:
                logger.debug("Refreshing expired YouTube credentials")
                credentials.refresh(Request())
            else:
                if not os.path.exists(self.client_secrets_path):
                    logger.debug("Client secrets file missing at %s", self.client_secrets_path)
                    raise FileNotFoundError(
                        f"Client secrets file not found: {self.client_secrets_path}. "
                        "Create OAuth credentials in Google Cloud and download JSON."
                    )
                logger.debug("Starting OAuth flow using %s", self.client_secrets_path)
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.client_secrets_path, SCOPES
                )
                credentials = flow.run_local_server(port=0)

            with open(self.token_path, "w", encoding="utf-8") as token_file:
                token_file.write(credentials.to_json())
            logger.debug("Persisted refreshed YouTube credentials to %s", self.token_path)

        logger.debug("YouTube credentials ready valid=%s", credentials.valid)
        return credentials

    def fetch_all_subscriptions(self) -> List[Dict[str, Any]]:
        """Fetch all user subscriptions with pagination."""
        logger.debug("Fetching all YouTube subscriptions")
        subscriptions: List[Dict[str, Any]] = []
        next_page_token = None
        page_count = 0

        while True:
            logger.debug("Requesting subscriptions page page_token=%s", next_page_token)
            request = self.youtube.subscriptions().list(
                part="snippet,contentDetails",
                mine=True,
                maxResults=50,
                pageToken=next_page_token,
            )
            response = request.execute()
            page_count += 1

            for item in response.get("items", []):
                snippet = item.get("snippet", {})
                resource_id = snippet.get("resourceId", {})
                subscriptions.append(
                    {
                        "subscriptionId": item.get("id"),
                        "channelId": resource_id.get("channelId"),
                        "channelTitle": snippet.get("title"),
                        "channelDescription": snippet.get("description", ""),
                        "thumbnailUrl": snippet.get("thumbnails", {}).get("default", {}).get("url"),
                        "subscriptionDate": snippet.get("publishedAt"),
                    }
                )

            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break

        logger.debug(
            "Fetched subscriptions page_count=%s total_subscriptions=%s",
            page_count,
            len(subscriptions),
        )
        return subscriptions

    def fetch_recent_uploads_for_channel(
        self, channel_id: str, limit: int = 50, published_after: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        """Fetch recent uploads for a single channel.

        If published_after is provided, only videos published strictly after that
        timestamp are returned.  The uploads playlist is date-ordered (newest first),
        so fetching stops as soon as an older video is encountered, making incremental
        syncs very fast for channels that haven't posted recently.
        """
        logger.debug(
            "Fetching recent uploads channel_id=%s limit=%s published_after=%s",
            channel_id,
            limit,
            published_after,
        )
        if not channel_id:
            logger.debug("Skipping recent uploads fetch because channel_id is empty")
            return []

        # Normalise published_after to timezone-aware UTC for comparison
        cutoff: Optional[datetime] = None
        if published_after is not None:
            cutoff = (
                published_after.replace(tzinfo=timezone.utc)
                if published_after.tzinfo is None
                else published_after
            )

        try:
            channels_response = (
                self.youtube.channels()
                .list(part="contentDetails", id=channel_id, maxResults=1)
                .execute()
            )

            items = channels_response.get("items", [])
            if not items:
                logger.debug("No channel metadata found for channel_id=%s", channel_id)
                return []

            uploads_playlist_id = (
                items[0]
                .get("contentDetails", {})
                .get("relatedPlaylists", {})
                .get("uploads")
            )

            if not uploads_playlist_id:
                logger.debug("No uploads playlist found for channel_id=%s", channel_id)
                return []

            videos: List[Dict[str, Any]] = []
            next_page_token = None

            while len(videos) < limit:
                playlist_response = (
                    self.youtube.playlistItems()
                    .list(
                        part="snippet,contentDetails",
                        playlistId=uploads_playlist_id,
                        maxResults=50,
                        pageToken=next_page_token,
                    )
                    .execute()
                )

                stop_early = False
                for item in playlist_response.get("items", []):
                    snippet = item.get("snippet", {})
                    content_details = item.get("contentDetails", {})
                    video_id = content_details.get("videoId")

                    # Use videoPublishedAt (more accurate) then fall back to snippet date
                    published_at_str = content_details.get("videoPublishedAt") or snippet.get("publishedAt")

                    pub_dt: Optional[datetime] = None
                    if published_at_str:
                        try:
                            pub_dt = datetime.fromisoformat(published_at_str.replace("Z", "+00:00"))
                        except ValueError:
                            pass

                    # Stop as soon as we reach a video at or before the cutoff –
                    # all remaining items are even older.
                    if cutoff is not None and pub_dt is not None and pub_dt <= cutoff:
                        stop_early = True
                        break

                    thumbnail = (
                        snippet.get("thumbnails", {}).get("medium", {}).get("url")
                        or snippet.get("thumbnails", {}).get("default", {}).get("url")
                    )
                    videos.append(
                        {
                            "videoId": video_id,
                            "title": snippet.get("title"),
                            "publishedAt": published_at_str,
                            "thumbnailUrl": thumbnail,
                        }
                    )

                    if len(videos) >= limit:
                        stop_early = True
                        break

                if stop_early:
                    break

                next_page_token = playlist_response.get("nextPageToken")
                if not next_page_token:
                    break

            logger.debug(
                "Fetched recent uploads channel_id=%s video_count=%s cutoff=%s",
                channel_id,
                len(videos),
                cutoff,
            )
            return videos
        except HttpError:
            logger.exception("Error fetching uploads for channel_id=%s", channel_id)
            return []

    def fetch_video_details(self, video_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        """Fetch duration and content type for up to 50*N video IDs (batched).

        Returns a dict mapping video_id -> {"duration_seconds": int, "video_type": str}.
        """
        if not video_ids:
            return {}

        details: Dict[str, Dict[str, Any]] = {}

        for i in range(0, len(video_ids), 50):
            batch = video_ids[i : i + 50]
            logger.debug("Fetching video details batch offset=%s size=%s", i, len(batch))
            try:
                response = (
                    self.youtube.videos()
                    .list(part="contentDetails,snippet", id=",".join(batch))
                    .execute()
                )
                for item in response.get("items", []):
                    vid_id = item.get("id")
                    content_details = item.get("contentDetails", {})
                    snippet = item.get("snippet", {})

                    duration_seconds = _parse_iso8601_duration(content_details.get("duration", ""))

                    live_status = snippet.get("liveBroadcastContent", "none")
                    if live_status in ("live", "upcoming"):
                        video_type = "live"
                    elif duration_seconds is not None and duration_seconds <= 60:
                        video_type = "short"
                    else:
                        video_type = "video"

                    details[vid_id] = {
                        "duration_seconds": duration_seconds,
                        "video_type": video_type,
                    }
            except HttpError:
                logger.exception("Error fetching video details for batch offset=%s", i)

        logger.debug("Fetched video details for %s/%s videos", len(details), len(video_ids))
        return details

    def fetch_watch_progress(self, target_video_ids: List[str], max_pages: int = 5) -> Dict[str, int]:
        """Fetch watch progress from YouTube's InnerTube API.

        Uses the TVHTML5 client via youtubei.googleapis.com to browse
        watch history (FEhistory).  Each history entry includes a
        percentDurationWatched overlay.

        Args:
            target_video_ids: Video IDs to look up progress for.
            max_pages: Maximum history pages to fetch (each ~15 videos).

        Returns:
            Dict mapping video_id -> percent watched (0-100).
        """
        if not target_video_ids:
            return {}

        # Ensure credentials are fresh
        if self.credentials.expired and self.credentials.refresh_token:
            self.credentials.refresh(Request())

        target_set: Set[str] = set(target_video_ids)
        progress: Dict[str, int] = {}
        continuation_token: Optional[str] = None

        innertube_url = "https://youtubei.googleapis.com/youtubei/v1/browse"
        headers = {
            "Authorization": f"Bearer {self.credentials.token}",
            "Content-Type": "application/json",
        }
        client_context = {
            "client": {
                "clientName": "TVHTML5",
                "clientVersion": "7.20250320",
            }
        }

        logger.debug(
            "Fetching watch progress for %s target videos max_pages=%s",
            len(target_set),
            max_pages,
        )

        pages_fetched = 0
        for page in range(max_pages):
            pages_fetched = page + 1
            if page == 0:
                body: Dict[str, Any] = {
                    "context": client_context,
                    "browseId": "FEhistory",
                }
            else:
                if not continuation_token:
                    break
                body = {
                    "context": client_context,
                    "continuation": continuation_token,
                }

            try:
                resp = http_requests.post(
                    innertube_url, headers=headers, json=body, timeout=30
                )
                resp.raise_for_status()
                data = resp.json()
            except Exception:
                logger.exception("InnerTube browse request failed page=%s", page)
                break

            # Extract tile renderers and continuation token
            tiles, continuation_token = self._parse_history_tiles(data, page == 0)

            for tile in tiles:
                vid_id = tile.get("contentId")
                if not vid_id or vid_id not in target_set:
                    continue
                header = tile.get("header", {}).get("tileHeaderRenderer", {})
                for overlay in header.get("thumbnailOverlays", []):
                    resume = overlay.get("thumbnailOverlayResumePlaybackRenderer")
                    if resume:
                        progress[vid_id] = resume.get("percentDurationWatched", 0)
                        break
                else:
                    # In history but no resume overlay → fully watched
                    if vid_id not in progress:
                        progress[vid_id] = 100

            # Stop early if we found progress for all target videos
            if target_set.issubset(progress.keys()):
                break

        logger.debug(
            "Fetched watch progress found=%s/%s pages_fetched=%s",
            len(progress),
            len(target_set),
            pages_fetched,
        )
        return progress

    @staticmethod
    def _parse_history_tiles(
        data: Dict[str, Any], is_first_page: bool
    ) -> tuple:
        """Extract tileRenderer items and continuation token from InnerTube history response."""
        tiles: List[Dict[str, Any]] = []
        continuation_token: Optional[str] = None

        if is_first_page:
            grid = (
                data.get("contents", {})
                .get("tvBrowseRenderer", {})
                .get("content", {})
                .get("tvSurfaceContentRenderer", {})
                .get("content", {})
                .get("gridRenderer", {})
            )
        else:
            grid = (
                data.get("continuationContents", {})
                .get("gridContinuation", {})
            )

        for item in grid.get("items", []):
            if "tileRenderer" in item:
                tiles.append(item["tileRenderer"])

        for cont in grid.get("continuations", []):
            token = cont.get("nextContinuationData", {}).get("continuation")
            if token:
                continuation_token = token

        return tiles, continuation_token

    def create_playlist(self, title: str, description: str = "") -> str:
        """Create a private YouTube playlist and return its ID."""
        logger.debug("Creating YouTube playlist title=%s", title)
        response = self.youtube.playlists().insert(
            part="snippet,status",
            body={
                "snippet": {
                    "title": title,
                    "description": description,
                },
                "status": {
                    "privacyStatus": "private",
                },
            },
        ).execute()
        playlist_id = response.get("id")
        if not playlist_id:
            raise RuntimeError("Playlist creation returned no ID")
        logger.debug("Created YouTube playlist id=%s", playlist_id)
        return playlist_id

    def add_videos_to_playlist(self, playlist_id: str, video_ids: List[str]) -> int:
        """Add videos to a YouTube playlist in order and return the count added."""
        if not playlist_id or not video_ids:
            return 0

        added = 0
        for video_id in video_ids:
            logger.debug("Adding video to playlist playlist_id=%s video_id=%s", playlist_id, video_id)
            self.youtube.playlistItems().insert(
                part="snippet",
                body={
                    "snippet": {
                        "playlistId": playlist_id,
                        "resourceId": {
                            "kind": "youtube#video",
                            "videoId": video_id,
                        },
                    }
                },
            ).execute()
            added += 1

        logger.debug("Added %s videos to playlist_id=%s", added, playlist_id)
        return added

    def unsubscribe_from_channel(self, subscription_id: str) -> bool:
        """Delete a subscription from YouTube.
        
        Args:
            subscription_id: The YouTube subscription ID (not channel ID)
            
        Returns:
            True if successful, False otherwise
        """
        logger.debug("Unsubscribing from YouTube subscription_id=%s", subscription_id)
        try:
            self.youtube.subscriptions().delete(id=subscription_id).execute()
            logger.debug("Successfully unsubscribed subscription_id=%s", subscription_id)
            return True
        except HttpError:
            logger.exception("Error unsubscribing from subscription_id=%s", subscription_id)
            return False

    # region Cast via YouTube Lounge API

    _LOUNGE_BASE = "https://www.youtube.com/"
    _LOUNGE_TOKEN_URL = _LOUNGE_BASE + "api/lounge/pairing/get_lounge_token_batch"
    _LOUNGE_BIND_URL = _LOUNGE_BASE + "api/lounge/bc/bind"
    _LOUNGE_HEADERS = {
        "Origin": "https://www.youtube.com/",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    _LOUNGE_ID_HEADER = "X-YouTube-LoungeId-Token"
    _LOUNGE_BIND_DATA = {
        "device": "REMOTE_CONTROL",
        "id": "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        "name": "YTSubsOrganizer",
        "mdx-version": 3,
        "pairing_type": "cast",
        "app": "android-phone-13.14.55",
    }

    def cast_to_receiver(
        self,
        screen_id: str,
        video_id: str,
        playlist_id: str = "",
        video_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Start playback on a YouTube Cast receiver via the Lounge API.

        Returns a dict with session identifiers that must be passed to subsequent
        commands (e.g. ``send_lounge_command``).
        """
        logger.debug(
            "cast_to_receiver screen_id=%s video_id=%s playlist_id=%s video_ids=%s",
            screen_id, video_id, playlist_id, video_ids,
        )

        # Step 1 – obtain a lounge token for the screen
        logger.debug("Lounge: requesting lounge token for screen_id=%s", screen_id)
        token_resp = http_requests.post(
            self._LOUNGE_TOKEN_URL,
            data={"screen_ids": screen_id},
            headers=self._LOUNGE_HEADERS,
            timeout=10,
        )
        logger.debug(
            "Lounge: token response status=%s body=%s",
            token_resp.status_code, token_resp.text[:500],
        )
        token_resp.raise_for_status()
        screens = token_resp.json().get("screens", [])
        if not screens:
            raise RuntimeError("Lounge token response contained no screens")
        lounge_token = screens[0].get("loungeToken")
        if not lounge_token:
            raise RuntimeError("Lounge token missing from response")
        logger.debug("Lounge: obtained lounge_token (length=%s)", len(lounge_token))

        # Step 2 – bind to get SID and gsessionid
        logger.debug("Lounge: binding session")
        bind_headers = {
            **self._LOUNGE_HEADERS,
            self._LOUNGE_ID_HEADER: lounge_token,
        }
        bind_resp = http_requests.post(
            self._LOUNGE_BIND_URL,
            data=self._LOUNGE_BIND_DATA,
            headers=bind_headers,
            params={"RID": 0, "VER": 8, "CVER": 1},
            timeout=10,
        )
        logger.debug(
            "Lounge: bind response status=%s body=%s",
            bind_resp.status_code, bind_resp.text[:500],
        )
        bind_resp.raise_for_status()
        bind_content = bind_resp.text

        sid_match = re.search(r'"c","(.*?)",\"', bind_content)
        gsession_match = re.search(r'"S","(.*?)"]', bind_content)
        if not sid_match or not gsession_match:
            raise RuntimeError(
                f"Failed to parse lounge bind response (length={len(bind_content)}): "
                + bind_content[:300]
            )
        sid = sid_match.group(1)
        gsession_id = gsession_match.group(1)
        logger.debug("Lounge: bound SID=%s gsessionid=%s", sid, gsession_id)

        # Step 3 – send setPlaylist command (RID=1)
        all_ids = video_ids or [video_id]
        playlist_data = {
            "count": 1,
            "req0__sc": "setPlaylist",
            "req0_videoId": video_id,
            "req0_videoIds": ",".join(all_ids),
            "req0_currentTime": "0",
            "req0_currentIndex": -1,
            "req0_audioOnly": "false",
        }
        if playlist_id:
            playlist_data["req0_listId"] = playlist_id
        logger.debug("Lounge: sending setPlaylist data=%s", playlist_data)
        play_resp = http_requests.post(
            self._LOUNGE_BIND_URL,
            data=playlist_data,
            headers=bind_headers,
            params={
                "SID": sid,
                "gsessionid": gsession_id,
                "RID": 1,
                "VER": 8,
                "CVER": 1,
            },
            timeout=10,
        )
        logger.debug(
            "Lounge: setPlaylist response status=%s body=%s",
            play_resp.status_code, play_resp.text[:500],
        )
        play_resp.raise_for_status()

        logger.info(
            "Lounge: playback started video_id=%s playlist_id=%s screen_id=%s SID=%s",
            video_id, playlist_id, screen_id, sid,
        )
        return {
            "success": True,
            "video_id": video_id,
            "playlist_id": playlist_id,
            "screen_id": screen_id,
            "lounge_token": lounge_token,
            "SID": sid,
            "gsessionid": gsession_id,
        }

    def get_now_playing(
        self,
        lounge_token: str,
        sid: str,
        gsessionid: str,
    ) -> Optional[Dict[str, Any]]:
        """Query the Lounge session for the currently playing video.

        Returns a dict with 'videoId' and 'currentIndex' or None on failure.
        """
        logger.debug("Lounge: querying nowPlaying SID=%s", sid)
        bind_headers = {
            **self._LOUNGE_HEADERS,
            self._LOUNGE_ID_HEADER: lounge_token,
        }
        try:
            nonce = 42  # arbitrary offset ID for long-polling request
            resp = http_requests.get(
                self._LOUNGE_BIND_URL,
                headers=bind_headers,
                params={
                    "SID": sid,
                    "gsessionid": gsessionid,
                    "RID": "rpc",
                    "CI": 0,
                    "TYPE": "xmlhttp",
                    "AID": nonce,
                    "VER": 8,
                    "CVER": 1,
                },
                timeout=(5, 3),
                stream=True,
            )
            resp.raise_for_status()
            # Read only the first chunk — the Lounge endpoint is a long-poll
            # that streams data and holds the connection open indefinitely.
            body = ""
            for chunk in resp.iter_content(chunk_size=4096, decode_unicode=True):
                if chunk:
                    body += chunk
                # The initial batch always contains nowPlaying; stop after first chunk
                if body:
                    break
            resp.close()
            logger.debug("Lounge: nowPlaying response length=%s body=%s", len(body), body[:1000])

            # Parse the long-poll response for nowPlaying data.
            # The response is a series of numbered arrays.  We look for
            # an entry containing "nowPlaying" followed by a dict.
            now_playing_match = re.search(
                r'"nowPlaying"\s*,\s*\{([^}]+)\}', body
            )
            if not now_playing_match:
                logger.debug("Lounge: no nowPlaying entry in response")
                return None

            raw = "{" + now_playing_match.group(1) + "}"
            # Parse key-value pairs from the Lounge format: "key":"value"
            pairs: Dict[str, str] = {}
            for kv_match in re.finditer(r'"(\w+)"\s*:\s*"([^"]*)"', raw):
                pairs[kv_match.group(1)] = kv_match.group(2)

            logger.debug("Lounge: nowPlaying parsed=%s", pairs)
            return pairs
        except Exception:
            logger.exception("Lounge: failed to query nowPlaying")
            return None

    # endregion
