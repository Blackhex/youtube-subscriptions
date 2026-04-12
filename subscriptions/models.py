from django.db import models


class Category(models.Model):
    name = models.CharField(max_length=256)
    description = models.TextField(blank=True, null=True)
    parent = models.ForeignKey(
        'self', on_delete=models.CASCADE, null=True, blank=True, related_name='children'
    )
    sort_order = models.IntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'categories'
        ordering = ['sort_order', 'name']

    def __str__(self):
        return self.name


class Subscription(models.Model):
    subscription_id = models.CharField(max_length=256, unique=True, null=True, blank=True)
    channel_id = models.CharField(max_length=256, unique=True)
    channel_title = models.CharField(max_length=256)
    channel_description = models.TextField(blank=True, null=True)
    thumbnail_url = models.URLField(max_length=512, blank=True, null=True)
    thumbnail_path = models.CharField(max_length=512, blank=True, null=True)
    subscription_date = models.DateTimeField(blank=True, null=True)
    subscriber_count = models.CharField(max_length=32, blank=True, null=True)
    topics = models.JSONField(blank=True, null=True)
    topic_in_topic_cache = models.BooleanField(default=False)
    last_published_at = models.CharField(max_length=64, blank=True, null=True)
    synced_at = models.DateTimeField(blank=True, null=True)
    videos_synced_at = models.DateTimeField(blank=True, null=True)
    # Resume point for the backwards walk through the uploads playlist; None means start over
    uploads_page_token = models.CharField(max_length=256, blank=True, null=True)
    uploads_backfilled = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    categories = models.ManyToManyField(Category, through='SubscriptionCategory', blank=True)

    class Meta:
        db_table = 'subscriptions'
        ordering = ['channel_title']

    def __str__(self):
        return self.channel_title


class SubscriptionCategory(models.Model):
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE)
    category = models.ForeignKey(Category, on_delete=models.CASCADE)
    position = models.IntegerField(null=True, blank=True)

    class Meta:
        db_table = 'subscription_category'
        unique_together = ('subscription', 'category')


class Video(models.Model):
    video_id = models.CharField(max_length=32, unique=True)
    channel = models.ForeignKey(
        Subscription, to_field='channel_id', on_delete=models.CASCADE,
        related_name='videos', db_column='channel_id'
    )
    title = models.CharField(max_length=512)
    description = models.TextField(blank=True, null=True)
    thumbnail_url = models.URLField(max_length=512, blank=True, null=True)
    thumbnail_path = models.CharField(max_length=512, blank=True, null=True)
    published_at = models.DateTimeField(blank=True, null=True)
    duration_seconds = models.IntegerField(blank=True, null=True)
    video_type = models.CharField(max_length=32, blank=True, null=True)
    playback_progress = models.IntegerField(blank=True, null=True)
    watched_locally = models.BooleanField(default=False)
    fetched_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'videos'
        ordering = ['-published_at']

    def __str__(self):
        return self.title


class QueueItem(models.Model):
    video = models.OneToOneField(
        Video, to_field='video_id', on_delete=models.CASCADE, db_column='video_id'
    )
    sort_order = models.IntegerField()
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'queue_items'
        ordering = ['sort_order']


class Feed(models.Model):
    name = models.CharField(max_length=256)
    sort_order = models.IntegerField(default=0)
    filter_category_ids = models.JSONField(blank=True, null=True)
    filter_video_type = models.CharField(max_length=32, blank=True, null=True)
    filter_min_duration = models.IntegerField(blank=True, null=True)
    filter_max_duration = models.IntegerField(blank=True, null=True)
    filter_max_age_days = models.IntegerField(blank=True, null=True)
    filter_play_state = models.CharField(max_length=16, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'feeds'
        ordering = ['sort_order', 'name']

    def __str__(self):
        return self.name
