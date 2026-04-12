import json
import logging
import os
import re
import threading
import time
from urllib.parse import urlparse

import requests as http_requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger(__name__)

_oauth_state = {
    'in_progress': False,
    'auth_url': None,
    'error': None,
}
_oauth_lock = threading.Lock()

# ═════════════════════════════════════════════════════════════════════════════
# Class 1: YouTube Data API v3
# ═════════════════════════════════════════════════════════════════════════════

class YouTubePublicAPI:
    """YouTube Data API v3 client using OAuth credentials."""

    _THREE_MINUTE_SHORTS_START = '2024-10-15T00:00:00Z'

    def __init__(self, credentials):
        self.credentials = credentials
        self.youtube = build('youtube', 'v3', credentials=credentials)

    @classmethod
    def from_credentials(cls, credentials):
        """Factory: create instance from existing credentials."""
        return cls(credentials)

    # ── Retry Logic ──────────────────────────────────────────────────────

    def _execute_with_retry(self, request, max_retries: int = 3):
        """Execute a YouTube API request with retry for transient errors."""
        for attempt in range(max_retries):
            try:
                return request.execute()
            except HttpError as e:
                # YouTube returns 409 for concurrent playlist mutation conflicts (not a true 409 Conflict)
                if e.resp.status in (409, 500, 503) and attempt < max_retries - 1:
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
                    'thumbnail_url': (snippet.get('thumbnails', {}).get('medium', {}).get('url')
                                      or snippet.get('thumbnails', {}).get('default', {}).get('url')),
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
                    'thumbnail_url': (snippet.get('thumbnails', {}).get('medium', {}).get('url')
                                      or snippet.get('thumbnails', {}).get('default', {}).get('url')),
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
                    'thumbnail_url': (snippet.get('thumbnails', {}).get('medium', {}).get('url')
                                      or snippet.get('thumbnails', {}).get('default', {}).get('url')),
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
                part='contentDetails,snippet,liveStreamingDetails,player',
                maxWidth=1000,
            )
            response = self._execute_with_retry(request)

            for item in response.get('items', []):
                vid = item['id']
                snippet = item.get('snippet', {})
                content = item.get('contentDetails', {})
                live = item.get('liveStreamingDetails', {})
                player = item.get('player', {})

                duration_seconds = self._parse_iso8601_duration(content.get('duration'))
                live_broadcast = snippet.get('liveBroadcastContent', 'none')

                if live_broadcast == 'live':
                    video_type = 'live'
                elif live_broadcast == 'upcoming':
                    video_type = 'upcoming'
                elif self._is_short(
                    duration_seconds,
                    snippet.get('publishedAt'),
                    player,
                ):
                    video_type = 'short'
                else:
                    video_type = 'video'

                results[vid] = {
                    'duration_seconds': duration_seconds,
                    'video_type': video_type,
                    'title': snippet.get('title'),
                    'description': snippet.get('description'),
                    'thumbnail_url': (snippet.get('thumbnails', {}).get('medium', {}).get('url')
                                      or snippet.get('thumbnails', {}).get('default', {}).get('url')),
                    'published_at': snippet.get('publishedAt'),
                }

        logger.info("Fetched details for %d videos", len(results))
        return results

    @classmethod
    def _is_short(cls, duration_seconds, published_at, player) -> bool:
        if duration_seconds is None or duration_seconds > 180:
            return False

        try:
            width = int(player.get('embedWidth', 0))
            height = int(player.get('embedHeight', 0))
        except (TypeError, ValueError):
            width = height = 0

        if not width or not height:
            return duration_seconds <= 60
        if height < width:
            return False
        if duration_seconds <= 60:
            return True
        return bool(published_at and published_at >= cls._THREE_MINUTE_SHORTS_START)

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


# ═════════════════════════════════════════════════════════════════════════════
# Class 2: YouTube InnerTube + Lounge API
# ═════════════════════════════════════════════════════════════════════════════

class YouTubeInnerTubeAPI:
    """InnerTube API client using OAuth bearer token with TVHTML5 client context."""

    _INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/browse'
    _INNERTUBE_CONTEXT = {
        'client': {
            'clientName': 'TVHTML5',
            'clientVersion': '7.20250101',
        }
    }
    # ── Lounge API constants ─────────────────────────────────────────────
    _LOUNGE_TOKEN_URL = 'https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch'
    _LOUNGE_BIND_URL = 'https://www.youtube.com/api/lounge/bc/bind'
    _LOUNGE_SESSION_FILE = 'media/lounge_session.json'

    def __init__(self, credentials):
        self.credentials = credentials

    def _innertube_headers(self) -> dict:
        """Return standard InnerTube request headers with OAuth bearer token."""
        return {
            'Authorization': f'Bearer {self.credentials.token}',
            'Content-Type': 'application/json',
        }

    # ── InnerTube API Methods ────────────────────────────────────────────

    def fetch_innertube_subscriptions(self) -> list[dict]:
        """Fetch subscriptions via InnerTube FEchannels endpoint."""
        body = {
            'browseId': 'FEchannels',
            'context': self._INNERTUBE_CONTEXT,
        }
        headers = self._innertube_headers()

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

    def fetch_channel_video_progress(self, channel_id: str) -> dict[str, int]:
        """Fetch watch progress for videos on a channel via InnerTube channel browse.

        Returns {video_id: percent_watched} for videos with any watch progress.
        Uses the TVHTML5 client's channel Videos tab, which includes
        thumbnailOverlayResumePlaybackRenderer with percentDurationWatched.
        """
        body = {
            'browseId': channel_id,
            'params': 'EgZ2aWRlb3PyBgQKAjoA',  # Videos tab
            'context': self._INNERTUBE_CONTEXT,
        }
        headers = self._innertube_headers()

        try:
            resp = http_requests.post(self._INNERTUBE_URL, json=body, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            logger.exception("InnerTube channel browse failed for %s", channel_id)
            return {}

        progress_map: dict[str, int] = {}
        try:
            self._extract_tile_progress(data, progress_map)
        except Exception:
            logger.exception("Failed to parse channel browse for %s", channel_id)

        return progress_map

    @staticmethod
    def _extract_tile_progress(obj, progress_map: dict[str, int]):
        """Recursively extract video progress from tileRenderer elements."""
        if isinstance(obj, dict):
            if 'tileRenderer' in obj:
                tile = obj['tileRenderer']
                video_id = tile.get('contentId')
                if video_id:
                    overlays = (tile.get('header', {})
                                .get('tileHeaderRenderer', {})
                                .get('thumbnailOverlays', []))
                    for overlay in overlays:
                        pct = (overlay.get('thumbnailOverlayResumePlaybackRenderer', {})
                               .get('percentDurationWatched', 0))
                        if pct:
                            progress_map[video_id] = int(pct)
                            break
            for value in obj.values():
                YouTubeInnerTubeAPI._extract_tile_progress(value, progress_map)
        elif isinstance(obj, list):
            for item in obj:
                YouTubeInnerTubeAPI._extract_tile_progress(item, progress_map)

    # ── Lounge API Methods ───────────────────────────────────────────────

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
        if not video_ids:
            raise ValueError("At least one video is required for Cast")

        session = self._create_youtube_session(screen_id)
        session.play_video(video_ids[0])
        for video_id in video_ids[1:]:
            session.add_to_queue(video_id)
        logger.info("Cast %d videos to screen %s", len(video_ids), screen_id)

        session_data = {
            'screen_id': screen_id,
            'lounge_token': session._lounge_token,
            'sid': session._sid,
            'gsession_id': session._gsession_id,
            'video_ids': video_ids,
        }

        # Save session
        os.makedirs(os.path.dirname(self._LOUNGE_SESSION_FILE), exist_ok=True)
        with open(self._LOUNGE_SESSION_FILE, 'w') as f:
            json.dump(session_data, f)

        return session_data

    @staticmethod
    def _create_youtube_session(screen_id: str):
        from pychromecast.controllers.youtube import TimeoutYouTubeSession
        return TimeoutYouTubeSession(screen_id=screen_id, timeout=15)

    def get_now_playing(self, lounge_session: dict) -> dict | None:
        """Get the current playback state from a lounge session."""
        try:
            session = self._create_youtube_session(lounge_session.get('screen_id', ''))
            session._lounge_token = lounge_session.get('lounge_token')
            session._sid = lounge_session.get('sid')
            session._gsession_id = lounge_session.get('gsession_id')
            try:
                events = session.get_session_data()
            except http_requests.HTTPError as error:
                if error.response is None or error.response.status_code not in (400, 404):
                    raise
                events = session.get_session_data()

            refreshed = {
                'screen_id': lounge_session.get('screen_id'),
                'lounge_token': session._lounge_token,
                'sid': session._sid,
                'gsession_id': session._gsession_id,
            }
            session_changed = all(refreshed.values()) and any(
                lounge_session.get(key) != value
                for key, value in refreshed.items()
            )
            if session_changed:
                lounge_session.update(refreshed)
        except Exception:
            logger.exception("Failed to get now playing from lounge")
            return None

        playback = {
            'video_id': None,
            'state': None,
            'current_time': None,
            'video_ids': lounge_session.get('video_ids'),
        }
        for event in events:
            if not isinstance(event, list) or len(event) < 2:
                continue
            if event[0] in ('nowPlaying', 'onStateChange'):
                info = event[1] if isinstance(event[1], dict) else {}
                if info.get('videoId'):
                    playback['video_id'] = info['videoId']
                if info.get('state') is not None:
                    playback['state'] = info['state']
                if info.get('currentTime') is not None:
                    playback['current_time'] = info['currentTime']
                if info.get('mdxExpandedReceiverVideoIdList'):
                    playback['video_ids'] = [
                        video_id
                        for video_id in info['mdxExpandedReceiverVideoIdList'].split(',')
                        if video_id
                    ]

        if playback['video_id']:
            if playback.get('video_ids'):
                lounge_session['video_ids'] = playback['video_ids']
            playback = self._estimate_lounge_progress(
                lounge_session,
                playback,
                time.time(),
            )
            session_changed = True

        if session_changed:
            try:
                os.makedirs(os.path.dirname(self._LOUNGE_SESSION_FILE), exist_ok=True)
                with open(self._LOUNGE_SESSION_FILE, 'w') as session_file:
                    json.dump(lounge_session, session_file)
            except OSError:
                logger.warning("Failed to persist refreshed Lounge session")

        return playback if playback['video_id'] else None

    @staticmethod
    def _estimate_lounge_progress(lounge_session, playback, observed_at):
        try:
            reported_time = float(playback.get('current_time') or 0)
        except (TypeError, ValueError):
            reported_time = 0

        estimated_time = reported_time
        previous = lounge_session.get('playback')
        if (
            isinstance(previous, dict)
            and previous.get('video_id') == playback.get('video_id')
            and previous.get('state') == '1'
            and playback.get('state') == '1'
        ):
            try:
                same_reported_position = abs(
                    reported_time - float(previous.get('reported_time', 0))
                ) < 0.5
                elapsed = max(0, observed_at - float(previous.get('observed_at', observed_at)))
                if same_reported_position:
                    estimated_time = max(
                        reported_time,
                        float(previous.get('current_time', 0)) + elapsed,
                    )
            except (TypeError, ValueError):
                pass

        lounge_session['playback'] = {
            'video_id': playback.get('video_id'),
            'state': playback.get('state'),
            'reported_time': reported_time,
            'current_time': estimated_time,
            'observed_at': observed_at,
        }
        return {
            **playback,
            'current_time': estimated_time,
        }



# ═════════════════════════════════════════════════════════════════════════════
# Class 3: YouTube Cookie-based API
# ═════════════════════════════════════════════════════════════════════════════

class YouTubeCookieAPI:
    """Cookie-based YouTube API client using Playwright headless browser.

    Uses a persistent Playwright browser state for one-time interactive login,
    then uses headless Playwright for operations requiring browser-session auth.
    """

    _STATE_FILE = os.path.join('media', 'browser_state.json')

    def __init__(self):
        self._has_state = os.path.exists(self._STATE_FILE)
        if not self._has_state:
            logger.info("No YouTube session found. Install the browser extension to enable mark-as-watched.")

    @classmethod
    def _new_context(cls, browser, storage_state=None):
        """Create browser context with anti-detection init script."""
        context = browser.new_context(storage_state=storage_state)
        context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => false})")
        return context

    @staticmethod
    def _launch_browser(playwright):
        try:
            return playwright.chromium.launch(channel='chrome', headless=True)
        except Exception:
            return playwright.chromium.launch(headless=True)

    @classmethod
    def get_login_state(cls):
        """Return current session status."""
        return {
            'authenticated': os.path.exists(cls._STATE_FILE),
        }

    @classmethod
    def logout(cls):
        """Delete the saved browser state."""
        if os.path.exists(cls._STATE_FILE):
            os.remove(cls._STATE_FILE)
            logger.info("YouTube session deleted")

    def _refresh_session(self) -> bool:
        """Try to refresh YouTube session cookies by visiting youtube.com headlessly."""
        if not os.path.exists(self._STATE_FILE):
            return False
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                browser = self._launch_browser(p)
                context = self._new_context(browser, storage_state=self._STATE_FILE)
                page = context.new_page()
                page.goto('https://www.youtube.com', wait_until='domcontentloaded')
                # Check if we still have SAPISID
                cookies = context.cookies('https://www.youtube.com')
                sapisid = next(
                    (c for c in cookies if c['name'] in ('SAPISID', '__Secure-3PAPISID')),
                    None,
                )
                if sapisid:
                    state = context.storage_state()
                    with open(self._STATE_FILE, 'w') as f:
                        json.dump(state, f)
                    logger.info("YouTube session refreshed successfully")
                    context.close()
                    browser.close()
                    return True
                else:
                    logger.warning("Session refresh failed — SAPISID missing, re-login required")
                    context.close()
                    browser.close()
                    return False
        except Exception:
            logger.exception("Failed to refresh YouTube session")
            return False

    def report_watch(self, video_id: str, _retried: bool = False) -> bool:
        """Mark a video as fully watched using Playwright headless browser."""
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            logger.warning("Invalid video_id format: %s", video_id)
            return False

        if not self._has_state:
            # Re-check in case login happened after init
            self._has_state = os.path.exists(self._STATE_FILE)
            if not self._has_state:
                logger.warning("No browser state for report_watch — install the browser extension")
                return False

        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                browser = self._launch_browser(p)
                context = self._new_context(browser, storage_state=self._STATE_FILE)
                page = context.new_page()

                # Navigate to the watch page
                page.goto(f'https://www.youtube.com/watch?v={video_id}', wait_until='domcontentloaded')

                # Extract tracking URL and send ping from browser context
                result = page.evaluate('''() => {
                    try {
                        // Get the tracking URL from ytInitialPlayerResponse
                        const playerResponse = window.ytInitialPlayerResponse
                            || (typeof ytInitialPlayerResponse !== 'undefined' ? ytInitialPlayerResponse : null);
                        if (!playerResponse) return { error: 'No ytInitialPlayerResponse' };

                        const tracking = playerResponse.playbackTracking;
                        if (!tracking) return { error: 'No playbackTracking' };

                        const baseUrl = tracking.videostatsPlaybackUrl?.baseUrl;
                        if (!baseUrl) return { error: 'No videostatsPlaybackUrl' };

                        // Generate CPN
                        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
                        let cpn = '';
                        const values = crypto.getRandomValues(new Uint8Array(16));
                        for (const v of values) cpn += chars[v % chars.length];

                        // Build the stats URL: rewrite s.youtube.com to www.youtube.com
                        let statsUrl = baseUrl.replace(/^https:\\/\\/s\\.youtube\\.com\\//, 'https://www.youtube.com/');

                        // Parse and rebuild URL
                        const url = new URL(statsUrl);
                        url.searchParams.delete('len');
                        url.searchParams.set('cpn', cpn);
                        url.searchParams.set('ver', '2');
                        url.searchParams.set('final', '1');

                        return { statsUrl: url.toString() };
                    } catch (e) {
                        return { error: e.message };
                    }
                }''')

                if 'error' in result:
                    logger.warning("Failed to extract tracking URL for %s: %s", video_id, result['error'])
                    context.close()
                    browser.close()
                    # Try session refresh on first failure
                    if not _retried and self._refresh_session():
                        return self.report_watch(video_id, _retried=True)
                    return False

                stats_url = result['statsUrl']

                # Validate domain
                parsed = urlparse(stats_url)
                if parsed.scheme != 'https' or not (parsed.hostname or '').endswith(('.youtube.com', '.google.com')):
                    logger.warning("Unexpected tracking URL domain for %s: %s", video_id, stats_url)
                    context.close()
                    browser.close()
                    return False

                # Send the tracking ping from within the browser context
                # This ensures cookies are sent properly (same-origin)
                status = page.evaluate('''async (url) => {
                    try {
                        const resp = await fetch(url, { credentials: 'include' });
                        return resp.status;
                    } catch (e) {
                        return -1;
                    }
                }''', stats_url)

                # Save refreshed cookies from the page visit
                state = context.storage_state()
                with open(self._STATE_FILE, 'w') as f:
                    json.dump(state, f)

                context.close()
                browser.close()

                if status not in (200, 204):
                    logger.warning("Tracking ping failed for %s: status %d", video_id, status)
                    if not _retried and self._refresh_session():
                        return self.report_watch(video_id, _retried=True)
                    return False

                logger.info("Playwright report_watch for %s: status %d", video_id, status)
                return True

        except Exception:
            logger.exception("Failed to report watch (Playwright) for video %s", video_id)
            return False


# ═════════════════════════════════════════════════════════════════════════════
# Class 4: Facade
# ═════════════════════════════════════════════════════════════════════════════

class YouTubeService:
    """Facade that delegates to YouTubePublicAPI, YouTubeInnerTubeAPI, and YouTubeCookieAPI."""

    SCOPES = ['https://www.googleapis.com/auth/youtube']
    CLIENT_SECRETS_FILE = 'client_secret.json'
    TOKEN_FILE = 'token.json'

    def __init__(self):
        self.credentials = self._get_credentials()
        self.public = YouTubePublicAPI(self.credentials)
        self.innertube = YouTubeInnerTubeAPI(self.credentials)
        self._cookie = None
        # Backward compatibility: expose the googleapiclient service object
        self.youtube = self.public.youtube

    @classmethod
    def from_credentials(cls, credentials):
        """Factory: create instance from existing credentials."""
        instance = cls.__new__(cls)
        instance.credentials = credentials
        instance.public = YouTubePublicAPI(credentials)
        instance.innertube = YouTubeInnerTubeAPI(credentials)
        instance._cookie = None
        instance.youtube = instance.public.youtube
        return instance

    @property
    def cookie(self):
        if self._cookie is None:
            self._cookie = YouTubeCookieAPI()
        return self._cookie

    @cookie.setter
    def cookie(self, value):
        self._cookie = value

    @classmethod
    def get_oauth_state(cls):
        """Return current OAuth status."""
        return {
            'authenticated': os.path.exists(cls.TOKEN_FILE),
            'in_progress': _oauth_state['in_progress'],
            'auth_url': _oauth_state['auth_url'],
            'error': _oauth_state['error'],
        }

    @classmethod
    def start_oauth(cls):
        """Start OAuth flow in a background thread.

        Generates the auth URL and starts the callback listener on port 8085.
        Returns the auth URL for the frontend to open in a new tab.
        Does NOT open a browser on the server.
        """
        with _oauth_lock:
            if _oauth_state['in_progress']:
                return _oauth_state['auth_url']
            _oauth_state['in_progress'] = True
            _oauth_state['error'] = None
            _oauth_state['auth_url'] = None

        def _run():
            try:
                import http.server

                # Allow http://localhost for OAuth callback (safe for local dev)
                os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

                flow = InstalledAppFlow.from_client_secrets_file(
                    cls.CLIENT_SECRETS_FILE, cls.SCOPES
                )
                flow.redirect_uri = 'http://localhost:8085/'
                auth_url, _ = flow.authorization_url(prompt='consent')
                _oauth_state['auth_url'] = auth_url

                # Custom callback handler — uses the SAME flow object
                # so the state parameter matches
                class _CallbackHandler(http.server.BaseHTTPRequestHandler):
                    def do_GET(self):
                        logger.info("OAuth callback received: %s", self.path)
                        self.send_response(200)
                        self.send_header('Content-type', 'text/html')
                        self.end_headers()
                        self.wfile.write(
                            b'<html><body><h1>Sign-in complete!</h1>'
                            b'<p>You can close this tab.</p></body></html>'
                        )
                        # Only capture if this is the actual OAuth callback (has ?code= or ?error=)
                        if 'code=' in self.path or 'error=' in self.path:
                            self.server.callback_url = f'http://localhost:8085{self.path}'

                    def log_message(self, format, *args):
                        pass  # Suppress default request logs

                server = http.server.HTTPServer(('', 8085), _CallbackHandler)
                server.socket.setsockopt(
                    __import__('socket').SOL_SOCKET,
                    __import__('socket').SO_REUSEADDR, 1,
                )
                server.timeout = 300  # 5 minute timeout
                server.callback_url = None

                # Handle requests until we get the OAuth callback
                import time as _time
                deadline = _time.time() + 300
                while server.callback_url is None and _time.time() < deadline:
                    server.timeout = max(1, deadline - _time.time())
                    server.handle_request()

                if not server.callback_url:
                    _oauth_state['error'] = 'OAuth callback timed out (5 minutes)'
                    return

                flow.fetch_token(authorization_response=server.callback_url)
                creds = flow.credentials
                with open(cls.TOKEN_FILE, 'w') as f:
                    f.write(creds.to_json())
                logger.info("OAuth credentials saved successfully")
            except Exception as e:
                logger.exception("OAuth flow failed")
                _oauth_state['error'] = str(e)
            finally:
                with _oauth_lock:
                    _oauth_state['in_progress'] = False
                    _oauth_state['auth_url'] = None

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()

        # Wait briefly for the auth URL to be generated
        for _ in range(50):  # 5 seconds max
            if _oauth_state['auth_url']:
                return _oauth_state['auth_url']
            time.sleep(0.1)
        return _oauth_state['auth_url']

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
                if not os.path.exists(self.CLIENT_SECRETS_FILE):
                    raise FileNotFoundError(
                        f"OAuth client secrets file '{self.CLIENT_SECRETS_FILE}' not found. "
                        "Download it from Google Cloud Console."
                    )
                # Auto-start OAuth flow if not already in progress
                if not _oauth_state['in_progress']:
                    self.start_oauth()
                raise PermissionError(
                    "YouTube OAuth credentials not available. "
                    "Please sign in via the Google account icon in the app."
                )
            with open(self.TOKEN_FILE, 'w') as f:
                f.write(creds.to_json())
        return creds

    # ── Retry logic (kept on facade for backward compat) ─────────────────

    def _execute_with_retry(self, request, max_retries: int = 3):
        return self.public._execute_with_retry(request, max_retries)

    # ── Public API delegates ─────────────────────────────────────────────

    def fetch_subscriptions(self) -> list[dict]:
        return self.public.fetch_subscriptions()

    def fetch_channel_details(self, channel_ids):
        return self.public.fetch_channel_details(channel_ids)

    def fetch_uploads(self, playlist_id, max_results=50, published_after=None):
        return self.public.fetch_uploads(playlist_id, max_results, published_after)

    def fetch_video_details(self, video_ids):
        return self.public.fetch_video_details(video_ids)

    def fetch_playlists(self):
        return self.public.fetch_playlists()

    def fetch_playlist_items(self, playlist_id, max_results=50, page_token=None):
        return self.public.fetch_playlist_items(playlist_id, max_results, page_token)

    def add_to_playlist(self, playlist_id, video_id):
        return self.public.add_to_playlist(playlist_id, video_id)

    def remove_from_playlist(self, playlist_item_id):
        return self.public.remove_from_playlist(playlist_item_id)

    def create_playlist(self, title, description='', privacy='private'):
        return self.public.create_playlist(title, description, privacy)

    def delete_playlist(self, playlist_id):
        return self.public.delete_playlist(playlist_id)

    def delete_subscription(self, subscription_id):
        return self.public.delete_subscription(subscription_id)

    def reorder_playlist_item(self, playlist_id, item_id, resource_video_id, new_position):
        return self.public.reorder_playlist_item(playlist_id, item_id, resource_video_id, new_position)

    # ── InnerTube API delegates ──────────────────────────────────────────

    def fetch_innertube_subscriptions(self):
        return self.innertube.fetch_innertube_subscriptions()

    def fetch_channel_video_progress(self, channel_id):
        return self.innertube.fetch_channel_video_progress(channel_id)

    def get_lounge_token(self, screen_id):
        return self.innertube.get_lounge_token(screen_id)

    def cast_to_receiver(self, screen_id, video_ids, lounge_session=None):
        return self.innertube.cast_to_receiver(screen_id, video_ids, lounge_session)

    def get_now_playing(self, lounge_session):
        return self.innertube.get_now_playing(lounge_session)

    # ── Playback reporting ───────────────────────────────────────────────

    def report_watch(self, video_id):
        return self.cookie.report_watch(video_id)
