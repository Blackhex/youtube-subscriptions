from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r'categories', views.CategoryViewSet)
router.register(r'subscriptions', views.SubscriptionViewSet)
router.register(r'feeds', views.FeedViewSet)

urlpatterns = [
    path("health/", views.HealthCheckView.as_view(), name="health-check"),
    path("subscriptions/<str:channel_id>/thumbnail/", views.SubscriptionThumbnailView.as_view(), name="subscription-thumbnail"),
    path("subscriptions/<str:channel_id>/videos/", views.ChannelVideosView.as_view(), name="channel-videos"),
    path("subscriptions/<str:channel_id>/progress/", views.ChannelProgressView.as_view(), name="channel-progress"),
    path("videos/<str:video_id>/thumbnail/", views.VideoThumbnailView.as_view(), name="video-thumbnail"),
    path("sync/all/", views.SyncAllView.as_view(), name="sync-all"),
    path("sync/videos/", views.SyncVideosView.as_view(), name="sync-videos"),
    path("sync/status/", views.SyncStatusView.as_view(), name="sync-status"),
    # Queue endpoints (specific paths first)
    path("queue/reorder/", views.QueueReorderView.as_view(), name="queue-reorder"),
    path("queue/clear/", views.QueueClearView.as_view(), name="queue-clear"),
    path("queue/create-playlist/", views.QueueCreatePlaylistView.as_view(), name="queue-create-playlist"),
    path("queue/cast/", views.QueueCastView.as_view(), name="queue-cast"),
    path("queue/cast/status/", views.QueueCastStatusView.as_view(), name="queue-cast-status"),
    path("queue/refresh-progress/", views.QueueRefreshProgressView.as_view(), name="queue-refresh-progress"),
    path("queue/", views.QueueListCreateView.as_view(), name="queue-list-create"),
    path("queue/<int:pk>/", views.QueueDetailView.as_view(), name="queue-detail"),
    # Playlist endpoints (specific paths before generic)
    path("playlists/", views.PlaylistListView.as_view(), name="playlist-list"),
    path("playlists/<str:playlist_id>/", views.PlaylistDetailView.as_view(), name="playlist-detail"),
    path("playlists/<str:playlist_id>/items/", views.PlaylistItemsView.as_view(), name="playlist-items"),
    path("playlists/<str:playlist_id>/items/reorder/", views.PlaylistItemsReorderView.as_view(), name="playlist-items-reorder"),
    path("playlists/<str:playlist_id>/items/<str:item_id>/", views.PlaylistItemDetailView.as_view(), name="playlist-item-detail"),
    path("playlists/<str:playlist_id>/cast/", views.PlaylistCastView.as_view(), name="playlist-cast"),
    # Mark watched
    path("videos/<str:video_id>/mark-watched/", views.MarkWatchedView.as_view(), name="mark-watched"),
    # OAuth
    path("auth/oauth/", views.OAuthView.as_view(), name="oauth"),
    # YouTube session
    path("auth/youtube-session/", views.YouTubeSessionView.as_view(), name="youtube-session"),
    path("auth/youtube-session/cookies/", views.YouTubeSessionCookiesView.as_view(), name="youtube-session-cookies"),
] + router.urls
