import os
from datetime import datetime
from typing import Any, Dict, List

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]


class YouTubeService:
    def __init__(
        self, client_secrets_path: str = "client_secret.json", token_path: str = "token.json"
    ):
        self.client_secrets_path = client_secrets_path
        self.token_path = token_path
        self.credentials = self._get_credentials()
        self.youtube = build("youtube", "v3", credentials=self.credentials)

    def _get_credentials(self) -> Credentials:
        credentials = None

        if os.path.exists(self.token_path):
            credentials = Credentials.from_authorized_user_file(self.token_path, SCOPES)

        if not credentials or not credentials.valid:
            if credentials and credentials.expired and credentials.refresh_token:
                credentials.refresh(Request())
            else:
                if not os.path.exists(self.client_secrets_path):
                    raise FileNotFoundError(
                        f"Client secrets file not found: {self.client_secrets_path}. "
                        "Create OAuth credentials in Google Cloud and download JSON."
                    )
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.client_secrets_path, SCOPES
                )
                credentials = flow.run_local_server(port=0)

            with open(self.token_path, "w", encoding="utf-8") as token_file:
                token_file.write(credentials.to_json())

        return credentials

    def fetch_all_subscriptions(self) -> List[Dict[str, Any]]:
        """Fetch all user subscriptions with pagination."""
        subscriptions: List[Dict[str, Any]] = []
        next_page_token = None

        while True:
            request = self.youtube.subscriptions().list(
                part="snippet,contentDetails",
                mine=True,
                maxResults=50,
                pageToken=next_page_token,
            )
            response = request.execute()

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

        return subscriptions

    def fetch_recent_uploads_for_channel(
        self, channel_id: str, limit: int = 10
    ) -> List[Dict[str, Any]]:
        """Fetch recent uploads for a single channel."""
        if not channel_id:
            return []

        try:
            channels_response = (
                self.youtube.channels()
                .list(part="contentDetails", id=channel_id, maxResults=1)
                .execute()
            )

            items = channels_response.get("items", [])
            if not items:
                return []

            uploads_playlist_id = (
                items[0]
                .get("contentDetails", {})
                .get("relatedPlaylists", {})
                .get("uploads")
            )

            if not uploads_playlist_id:
                return []

            playlist_response = (
                self.youtube.playlistItems()
                .list(
                    part="snippet,contentDetails",
                    playlistId=uploads_playlist_id,
                    maxResults=max(1, min(limit, 50)),
                )
                .execute()
            )

            videos: List[Dict[str, Any]] = []
            for item in playlist_response.get("items", []):
                snippet = item.get("snippet", {})
                content_details = item.get("contentDetails", {})

                published_at = snippet.get("publishedAt")
                published_display = published_at
                if published_at:
                    try:
                        dt = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                        published_display = dt.isoformat()
                    except ValueError:
                        pass

                videos.append(
                    {
                        "videoId": content_details.get("videoId"),
                        "title": snippet.get("title"),
                        "publishedAt": published_display,
                        "thumbnailUrl": snippet.get("thumbnails", {}).get("default", {}).get("url"),
                    }
                )

            return videos
        except HttpError as err:
            print(f"Error fetching uploads for channel {channel_id}: {err}")
            return []

    def unsubscribe_from_channel(self, subscription_id: str) -> bool:
        """Delete a subscription from YouTube.
        
        Args:
            subscription_id: The YouTube subscription ID (not channel ID)
            
        Returns:
            True if successful, False otherwise
        """
        try:
            self.youtube.subscriptions().delete(id=subscription_id).execute()
            return True
        except HttpError as err:
            print(f"Error unsubscribing from subscription {subscription_id}: {err}")
            return False
