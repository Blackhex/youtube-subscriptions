from rest_framework import serializers

from .models import Category, Feed, QueueItem, Subscription, SubscriptionCategory, Video


class CategorySerializer(serializers.ModelSerializer):
    subscription_count = serializers.SerializerMethodField()
    children = serializers.SerializerMethodField()
    parent_id = serializers.PrimaryKeyRelatedField(
        queryset=Category.objects.all(), source='parent', allow_null=True, required=False
    )

    class Meta:
        model = Category
        fields = [
            'id', 'name', 'description', 'parent_id', 'sort_order',
            'subscription_count', 'children', 'created_at', 'updated_at',
        ]

    def get_subscription_count(self, obj):
        return SubscriptionCategory.objects.filter(category=obj).count()

    def get_children(self, obj):
        children = obj.children.all()
        return CategorySerializer(children, many=True, context=self.context).data


class SubscriptionCategoryInlineSerializer(serializers.ModelSerializer):
    id = serializers.IntegerField(source='category.id', read_only=True)
    name = serializers.CharField(source='category.name', read_only=True)

    class Meta:
        model = SubscriptionCategory
        fields = ['id', 'name']


class SubscriptionSerializer(serializers.ModelSerializer):
    categories = SubscriptionCategoryInlineSerializer(
        source='subscriptioncategory_set', many=True, read_only=True
    )
    thumbnail_url = serializers.SerializerMethodField()

    class Meta:
        model = Subscription
        fields = [
            'id', 'subscription_id', 'channel_id', 'channel_title',
            'channel_description', 'thumbnail_url', 'subscription_date', 'categories',
        ]

    def get_thumbnail_url(self, obj):
        return f'/api/subscriptions/{obj.channel_id}/thumbnail/'


class VideoSerializer(serializers.ModelSerializer):
    channel_title = serializers.CharField(source='channel.channel_title', read_only=True)
    thumbnail_url = serializers.SerializerMethodField()

    class Meta:
        model = Video
        fields = [
            'id', 'video_id', 'channel_id', 'title', 'thumbnail_url',
            'published_at', 'duration_seconds', 'video_type',
            'playback_progress', 'channel_title',
        ]

    def get_thumbnail_url(self, obj):
        return f'/api/videos/{obj.video_id}/thumbnail/'


class QueueItemSerializer(serializers.ModelSerializer):
    video = VideoSerializer(read_only=True)
    video_id = serializers.CharField(source='video.video_id', read_only=True)

    class Meta:
        model = QueueItem
        fields = ['id', 'video_id', 'sort_order', 'added_at', 'video']


class FeedSerializer(serializers.ModelSerializer):
    class Meta:
        model = Feed
        fields = '__all__'
