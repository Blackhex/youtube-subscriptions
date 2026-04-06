import json
import logging
import os
import re
import time
import uuid

import requests as http_requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger(__name__)


class YouTubeService:
    SCOPES = ['https://www.googleapis.com/auth/youtube']
    CLIENT_SECRETS_FILE = 'client_secret.json'
    TOKEN_FILE = 'token.json'

    def __init__(self):
        self.credentials = self._get_credentials()
        self.youtube = build('youtube', 'v3', credentials=self.credentials)

    @classmethod
    def from_credentials(cls, credentials):
        """Factory: create instance from existing credentials."""
        instance = cls.__new__(cls)
        instance.credentials = credentials
        instance.youtube = build('youtube', 'v3', credentials=credentials)
        return instance

    def _get_credentials(self) -> Credentials:
        """Load or obtain OAuth credentials."""
        creds = None
        if os.path.exists(self.TOKEN_FILE):
            creds = Credentials.from_authorized_user_file(self.TOKEN_FILE, self.SCOPES)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                try:
                    creds.refresh(Request())
                except Exception:
                    os.remove(self.TOKEN_FILE)
                    creds = None
            if not creds:
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.CLIENT_SECRETS_FILE, self.SCOPES
                )
                creds = flow.run_local_server(port=0)
            with open(self.TOKEN_FILE, 'w') as f:
                f.write(creds.to_json())
        return creds

    # ── Retry Logic ──────────────────────────────────────────────────────

    def _execute_with_retry(self, request, max_retries: int = 3):
        """Execute a YouTube API request with retry for transient errors."""
        for attempt in range(max_retries):
            try:
                return request.execute()
            except HttpError as e:
                if e.resp.status in (500, 503) and attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                raise

    # ── Data API v3 Methods ──────────────────────────────────────────────

    def fetch_subscriptions(self) -> list[dict]:
        """Paginated fetch of all user subscriptions."""
        subscriptions = []
        page_token = None

        while True:
            request = self.youtube.subscriptions().list(
                mine=True,
                part='snippet',
                maxResults=50,
                pageToken=page_token,
            )
            response = self._execute_with_retry(request)

            for item in response.get('items', []):
                snippet = item['snippet']
                subscriptions.append({
                    'subscription_id': item['id'],
                    'channel_id': snippet['resourceId']['channelId'],
                    'channel_title': snippet['title'],
                    'channel_description': snippet.get('description', ''),
                    'thumbnail_url': snippet.get('thumbnails', {}).get('default', {}).get('url'),
                    'subscription_date': snippet.get('publishedAt'),
                })

            page_token = response.get('nextPageToken')
            if not page_token:
                break

        logger.info("Fetched %d subscriptions from Data API", len(subscriptions))
        return subscriptions

    def fetch_channel_details(self, channel_ids: list[str]) -> dict[str, dict]:
        """Batch fetch channel info (up to 50 per request)."""
        results = {}

        for i in range(0, len(channel_ids), 50):
            batch = channel_ids[i:i + 50]
            request = self.youtube.channels().list(
                id=','.join(batch),
                part='contentDetails,snippet,statistics',
            )
            response = self._execute_with_retry(request)

            for item in response.get('items', []):
                cid = item['id']
                snippet = item.get('snippet', {})
                content = item.get('contentDetails', {})
                stats = item.get('statistics', {})
                results[cid] = {
                    'uploads_playlist_id': content.get('relatedPlaylists', {}).get('uploads'),
                    'title': snippet.get('title'),
                    'description': snippet.get('description'),
                    'thumbnail_url': snippet.get('thumbnails', {}).get('default', {}).get('url'),
                    'subscriber_count': stats.get('subscriberCount'),
                }

        logger.info("Fetched details for %d channels", len(results))
        return results

    def fetch_uploads(
        self,
        playlist_id: str,
        max_results: int = 50,
        published_after: str | None = None,
    ) -> list[dict]:
        """Fetch videos from an uploads playlist."""
        videos = []
        page_token = None

        while True:
            request = self.youtube.playlistItems().list(
                playlistId=playlist_id,
                part='snippet',
                maxResults=min(max_results - len(videos), 50),
                pageToken=page_token,
            )
            response = self._execute_with_retry(request)

            stop = False
            for item in response.get('items', []):
                snippet = item['snippet']
                published_at = snippet.get('publishedAt', '')

                if published_after and published_at < published_after:
                    stop = True
                    break

                videos.append({
                    'video_id': snippet['resourceId']['videoId'],
                    'title': snippet.get('title', ''),
                    'channel_id': snippet.get('channelId', ''),
                    'published_at': published_at,
                    'thumbnail_url': snippet.get('thumbnails', {}).get('default', {}).get('url'),
                })

            page_token = response.get('nextPageToken')
            if not page_token or stop or len(videos) >= max_results:
                break

        logger.info("Fetched %d uploads from playlist %s", len(videos), playlist_id)
        return videos

    def fetch_video_details(self, video_ids: list[str]) -> dict[str, dict]:
        """Batch fetch video details (up to 50 per request)."""
        results = {}

        for i in range(0, len(video_ids), 50):
            batch = video_ids[i:i + 50]
            request = self.youtube.videos().list(
                id=','.join(batch),
                part='contentDetails,snippet,liveStreamingDetails',
            )
            response = self._execute_with_retry(request)

            for item in response.get('items', []):
                vid = item['id']
                snippet = item.get('snippet', {})
                content = item.get('contentDetails', {})
                live = item.get('liveStreamingDetails', {})

                duration_seconds = self._parse_iso8601_duration(content.get('duration'))
                live_broadcast = snippet.get('liveBroadcastContent', 'none')

                if live_broadcast in ('live', 'upcoming'):
                    video_type = 'live'
                elif duration_seconds is not None and duration_seconds <= 60:
                    video_type = 'short'
                else:
                    video_type = 'video'

                results[vid] = {
                    'duration_seconds': duration_seconds,
                    'video_type': video_type,
                    'title': snippet.get('title'),
                    'description': snippet.get('description'),
                    'thumbnail_url': snippet.get('thumbnails', {}).get('default', {}).get('url'),
                    'published_at': snippet.get('publishedAt'),
                }

        logger.info("Fetched details for %d videos", len(results))
        return results

    def fetch_playlists(self) -> list[dict]:
        """Fetch all playlists owned by the user."""
        playlists = []
        page_token = None

        while True:
            request = self.youtube.playlists().list(
                mine=True,
                part='snippet,contentDetails,status',
                maxResults=50,
                pageToken=page_token,
            )
            response = self._execute_with_retry(request)

            for item in response.get('items', []):
                playlists.append(item)

            page_token = response.get('nextPageToken')
            if not page_token:
                break

        logger.info("Fetched %d playlists", len(playlists))
        return playlists

    def fetch_playlist_items(
        self, playlist_id: str, max_results: int = 50, page_token: str | None = None
    ) -> tuple[list[dict], str | None]:
        """Fetch items from any playlist. Returns (items, next_page_token)."""
        request = self.youtube.playlistItems().list(
            playlistId=playlist_id,
            part='snippet',
            maxResults=max_results,
            pageToken=page_token,
        )
        response = self._execute_with_retry(request)
        items = response.get('items', [])
        next_page = response.get('nextPageToken')
        return items, next_page

    def add_to_playlist(self, playlist_id: str, video_id: str) -> dict:
        """Add a video to a playlist."""
        request = self.youtube.playlistItems().insert(
            part='snippet',
            body={
                'snippet': {
                    'playlistId': playlist_id,
                    'resourceId': {
                        'kind': 'youtube#video',
                        'videoId': video_id,
                    },
                }
            },
        )
        result = self._execute_with_retry(request)
        logger.info("Added video %s to playlist %s", video_id, playlist_id)
        return result

    def remove_from_playlist(self, playlist_item_id: str) -> None:
        """Remove an item from a playlist."""
        request = self.youtube.playlistItems().delete(id=playlist_item_id)
        self._execute_with_retry(request)
        logger.info("Removed playlist item %s", playlist_item_id)

    def create_playlist(
        self, title: str, description: str = '', privacy: str = 'private'
    ) -> dict:
        """Create a new YouTube playlist."""
        request = self.youtube.playlists().insert(
            part='snippet,status',
            body={
                'snippet': {
                    'title': title,
                    'description': description,
                },
                'status': {
                    'privacyStatus': privacy,
                },
            },
        )
        result = self._execute_with_retry(request)
        logger.info("Created playlist '%s' (id=%s)", title, result.get('id'))
        return result

    def delete_playlist(self, playlist_id: str) -> None:
        """Delete a playlist."""
        request = self.youtube.playlists().delete(id=playlist_id)
        self._execute_with_retry(request)
        logger.info("Deleted playlist %s", playlist_id)

    def delete_subscription(self, subscription_id: str) -> None:
        """Unsubscribe from a channel."""
        request = self.youtube.subscriptions().delete(id=subscription_id)
        self._execute_with_retry(request)
        logger.info("Deleted subscription %s", subscription_id)

    def reorder_playlist_item(
        self,
        playlist_id: str,
        item_id: str,
        resource_video_id: str,
        new_position: int,
    ) -> dict:
        """Move an item within a playlist by updating its position."""
        request = self.youtube.playlistItems().update(
            part='snippet',
            body={
                'id': item_id,
                'snippet': {
                    'playlistId': playlist_id,
                    'resourceId': {
                        'kind': 'youtube#video',
                        'videoId': resource_video_id,
                    },
                    'position': new_position,
                },
            },
        )
        result = self._execute_with_retry(request)
        logger.info("Reordered item %s to position %d in playlist %s", item_id, new_position, playlist_id)
        return result

    # ── ISO 8601 Duration Parser ─────────────────────────────────────────

    @staticmethod
    def _parse_iso8601_duration(duration_str: str) -> int:
        """Parse ISO 8601 duration (PT#H#M#S) to seconds."""
        match = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', duration_str or '')
        if not match:
            return 0
        hours = int(match.group(1) or 0)
        minutes = int(match.group(2) or 0)
        seconds = int(match.group(3) or 0)
        return hours * 3600 + minutes * 60 + seconds

    # ── InnerTube API Methods ────────────────────────────────────────────

    _INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/browse'
    _INNERTUBE_CONTEXT = {
        'client': {
            'clientName': 'TVHTML5',
            'clientVersion': '7.20250101',
        }
    }

    def fetch_innertube_subscriptions(self) -> list[dict]:
        """Fetch subscriptions via InnerTube FEchannels endpoint."""
        body = {
            'browseId': 'FEchannels',
            'context': self._INNERTUBE_CONTEXT,
        }
        headers = {
            'Authorization': f'Bearer {self.credentials.token}',
            'Content-Type': 'application/json',
        }

        try:
            resp = http_requests.post(self._INNERTUBE_URL, json=body, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            logger.exception("InnerTube FEchannels request failed")
            return []

        channels = []
        try:
            tabs = data.get('contents', {}).get('tvBrowseRenderer', {}).get('content', {}).get('tvSurfaceContentRenderer', {}).get('content', {}).get('sectionListRenderer', {}).get('contents', [])
            if not tabs:
                tabs = data.get('contents', {}).get('twoColumnBrowseResultsRenderer', {}).get('tabs', [])
                for tab in tabs:
                    sections = tab.get('tabRenderer', {}).get('content', {}).get('sectionListRenderer', {}).get('contents', [])
                    for section in sections:
                        items = section.get('itemSectionRenderer', {}).get('contents', [])
                        for item in items:
                            grid_items = item.get('gridRenderer', {}).get('items', [])
                            for grid_item in grid_items:
                                renderer = grid_item.get('gridChannelRenderer', {})
                                if renderer:
                                    channel_id = renderer.get('channelId')
                                    title_runs = renderer.get('title', {}).get('runs', [])
                                    title = title_runs[0].get('text', '') if title_runs else renderer.get('title', {}).get('simpleText', '')
                                    if channel_id:
                                        channels.append({
                                            'channel_id': channel_id,
                                            'channel_title': title,
                                        })
            else:
                for section in tabs:
                    items = section.get('shelfRenderer', {}).get('content', {}).get('horizontalListRenderer', {}).get('items', [])
                    for item in items:
                        renderer = item.get('tileRenderer', {}) or item.get('gridChannelRenderer', {})
                        channel_id = renderer.get('channelId') or renderer.get('contentId')
                        title = renderer.get('metadata', {}).get('tileMetadataRenderer', {}).get('title', {}).get('simpleText', '')
                        if not title:
                            title_runs = renderer.get('title', {}).get('runs', [])
                            title = title_runs[0].get('text', '') if title_runs else ''
                        if channel_id:
                            channels.append({
                                'channel_id': channel_id,
                                'channel_title': title,
                            })
        except Exception:
            logger.exception("Failed to parse InnerTube FEchannels response")

        logger.info("Fetched %d channels from InnerTube FEchannels", len(channels))
        return channels

    def fetch_watch_history(self) -> dict[str, int]:
        """Fetch watch history via InnerTube FEhistory. Returns {video_id: progress_percent}."""
        body = {
            'browseId': 'FEhistory',
            'context': self._INNERTUBE_CONTEXT,
        }
        headers = {
            'Authorization': f'Bearer {self.credentials.token}',
            'Content-Type': 'application/json',
        }

        try:
            resp = http_requests.post(self._INNERTUBE_URL, json=body, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            logger.exception("InnerTube FEhistory request failed")
            return {}

        progress_map: dict[str, int] = {}
        try:
            tabs = data.get('contents', {}).get('twoColumnBrowseResultsRenderer', {}).get('tabs', [])
            if not tabs:
                tabs = data.get('contents', {}).get('tvBrowseRenderer', {}).get('content', {}).get('tvSurfaceContentRenderer', {}).get('content', {}).get('sectionListRenderer', {}).get('contents', [])

            for tab in tabs:
                sections = tab.get('tabRenderer', {}).get('content', {}).get('sectionListRenderer', {}).get('contents', [])
                if not sections:
                    sections = [tab]

                for section in sections:
                    items = section.get('itemSectionRenderer', {}).get('contents', [])
                    if not items:
                        items = section.get('shelfRenderer', {}).get('content', {}).get('horizontalListRenderer', {}).get('items', [])

                    for item in items:
                        renderer = (
                            item.get('videoRenderer', {})
                            or item.get('tileRenderer', {})
                            or item.get('gridVideoRenderer', {})
                        )
                        if not renderer:
                            continue

                        video_id = renderer.get('videoId') or renderer.get('contentId')
                        if not video_id:
                            continue

                        # Look for progress in overlay/thumbnail overlays
                        progress = 0
                        overlays = renderer.get('thumbnailOverlays', [])
                        for overlay in overlays:
                            progress_renderer = overlay.get('thumbnailOverlayResumePlaybackRenderer', {})
                            pct = progress_renderer.get('percentDurationWatched', 0)
                            if pct:
                                progress = int(pct)
                                break

                        # Also check tile overlays
                        if not progress:
                            tile_overlays = renderer.get('metadata', {}).get('tileMetadataRenderer', {}).get('overlays', [])
                            for overlay in tile_overlays:
                                pct = overlay.get('percentDurationWatched', 0)
                                if pct:
                                    progress = int(pct)
                                    break

                        if video_id:
                            progress_map[video_id] = progress
        except Exception:
            logger.exception("Failed to parse InnerTube FEhistory response")

        logger.info("Fetched watch progress for %d videos from InnerTube", len(progress_map))
        return progress_map

    # ── Lounge API Methods ───────────────────────────────────────────────

    _LOUNGE_TOKEN_URL = 'https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch'
    _LOUNGE_BIND_URL = 'https://www.youtube.com/api/lounge/bc/bind'
    _LOUNGE_SESSION_FILE = 'media/lounge_session.json'

    def get_lounge_token(self, screen_id: str) -> str:
        """Get a lounge token for the given screen ID."""
        resp = http_requests.post(
            self._LOUNGE_TOKEN_URL,
            data={'screen_ids': screen_id},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        screens = data.get('screens', [])
        if not screens:
            raise ValueError("No screens returned from lounge token batch")
        token = screens[0].get('loungeToken')
        if not token:
            raise ValueError("No loungeToken in response")
        logger.info("Got lounge token for screen %s", screen_id)
        return token

    def cast_to_receiver(
        self,
        screen_id: str,
        video_ids: list[str],
        lounge_session: dict | None = None,
    ) -> dict:
        """Cast videos to a receiver device via the Lounge API."""
        token = self.get_lounge_token(screen_id)
        device_id = str(uuid.uuid4())

        # Bind session
        bind_params = {
            'device': 'LOUNGE_SCREEN',
            'id': device_id,
            'loungeIdToken': token,
            'VER': '8',
            'RID': '1',
            'CVER': '1',
        }
        resp = http_requests.post(
            self._LOUNGE_BIND_URL,
            params=bind_params,
            timeout=15,
        )
        resp.raise_for_status()

        # Parse SID and gsessionid from response
        sid = None
        gsession_id = None
        for line in resp.text.splitlines():
            line = line.strip()
            if '"S"' in line or '"sid"' in line.lower():
                # Try JSON parse for structured lines
                pass
            if '"c"' in line:
                try:
                    parsed = json.loads('[' + line.rstrip(',') + ']')
                    if isinstance(parsed, list):
                        for entry in parsed:
                            if isinstance(entry, list) and len(entry) >= 2:
                                if entry[0] == 'c':
                                    sid = entry[1]
                                elif entry[0] == 'S':
                                    gsession_id = entry[1]
                except (json.JSONDecodeError, IndexError):
                    pass

        # Fallback: try to parse entire response body
        if not sid:
            try:
                lines = resp.text.strip().split('\n')
                for line in lines:
                    line = line.strip()
                    if not line or line.isdigit():
                        continue
                    try:
                        data = json.loads(line)
                        if isinstance(data, list):
                            for entry in data:
                                if isinstance(entry, list) and len(entry) >= 2:
                                    for sub in entry[1:]:
                                        if isinstance(sub, list) and len(sub) >= 2:
                                            if sub[0] == 'c':
                                                sid = sub[1]
                                            elif sub[0] == 'S':
                                                gsession_id = sub[1]
                    except json.JSONDecodeError:
                        continue
            except Exception:
                logger.warning("Could not parse SID/gsessionid from bind response")

        # Set playlist
        set_params = {
            'device': 'LOUNGE_SCREEN',
            'id': device_id,
            'loungeIdToken': token,
            'SID': sid or '',
            'gsessionid': gsession_id or '',
            'VER': '8',
            'RID': '2',
        }
        set_data = {
            'count': '1',
            'ofs': '0',
            'req0__sc': 'setPlaylist',
            'req0_videoIds': ','.join(video_ids),
        }
        resp = http_requests.post(
            self._LOUNGE_BIND_URL,
            params=set_params,
            data=set_data,
            timeout=15,
        )
        resp.raise_for_status()
        logger.info("Cast %d videos to screen %s", len(video_ids), screen_id)

        session_data = {
            'screen_id': screen_id,
            'device_id': device_id,
            'lounge_token': token,
            'sid': sid,
            'gsession_id': gsession_id,
        }

        # Save session
        os.makedirs(os.path.dirname(self._LOUNGE_SESSION_FILE), exist_ok=True)
        with open(self._LOUNGE_SESSION_FILE, 'w') as f:
            json.dump(session_data, f)

        return session_data

    def get_now_playing(self, lounge_session: dict) -> dict | None:
        """Get the current playback state from a lounge session."""
        params = {
            'device': 'LOUNGE_SCREEN',
            'id': lounge_session.get('device_id', ''),
            'loungeIdToken': lounge_session.get('lounge_token', ''),
            'SID': lounge_session.get('sid', ''),
            'gsessionid': lounge_session.get('gsession_id', ''),
            'VER': '8',
            'RID': 'rpc',
            'CI': '0',
            'TYPE': 'xmlhttp',
        }

        try:
            resp = http_requests.get(
                self._LOUNGE_BIND_URL,
                params=params,
                timeout=15,
            )
            resp.raise_for_status()
        except Exception:
            logger.exception("Failed to get now playing from lounge")
            return None

        # Parse the response for now playing info
        try:
            lines = resp.text.strip().split('\n')
            for line in lines:
                line = line.strip()
                if not line or line.isdigit():
                    continue
                try:
                    data = json.loads(line)
                    if isinstance(data, list):
                        for entry in data:
                            if isinstance(entry, list) and len(entry) >= 2:
                                for sub in entry[1:]:
                                    if isinstance(sub, list) and len(sub) >= 2:
                                        if sub[0] == 'nowPlaying':
                                            info = sub[1] if len(sub) > 1 else {}
                                            return {
                                                'video_id': info.get('videoId'),
                                                'state': info.get('state'),
                                                'current_time': info.get('currentTime'),
                                            }
                                        if sub[0] == 'onStateChange':
                                            info = sub[1] if len(sub) > 1 else {}
                                            return {
                                                'video_id': info.get('videoId'),
                                                'state': info.get('state'),
                                                'current_time': info.get('currentTime'),
                                            }
                except json.JSONDecodeError:
                    continue
        except Exception:
            logger.exception("Failed to parse now playing response")

        return None
