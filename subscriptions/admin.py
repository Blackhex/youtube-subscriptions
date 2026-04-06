from django.contrib import admin

from .models import Category, Feed, QueueItem, Subscription, Video

admin.site.register(Category)
admin.site.register(Subscription)
admin.site.register(Video)
admin.site.register(QueueItem)
admin.site.register(Feed)
