import json
import logging
import os
import re

import requests

from .models import Category, Subscription

logger = logging.getLogger(__name__)

GEMINI_API_KEY_FILE = 'gemini_api_key.txt'


def get_suggestions(subscription: Subscription) -> list[int]:
    """Get category suggestions for a subscription. Tries Gemini first, falls back to heuristic."""
    categories = list(Category.objects.all().values('id', 'name'))
    if not categories:
        return []

    # Try Gemini first
    suggested = gemini_suggestions(subscription, categories)
    if suggested:
        return suggested

    # Fallback to heuristic
    return heuristic_suggestions(subscription, categories)


def gemini_suggestions(subscription: Subscription, categories: list[dict]) -> list[int]:
    """Use Gemini API to suggest categories."""
    if not os.path.exists(GEMINI_API_KEY_FILE):
        return []

    with open(GEMINI_API_KEY_FILE) as f:
        api_key = f.read().strip()
    if not api_key:
        return []

    category_names = {c['id']: c['name'] for c in categories}
    prompt = (
        f"Given this YouTube channel:\n"
        f"Title: {subscription.channel_title}\n"
        f"Description: {subscription.channel_description or 'N/A'}\n\n"
        f"And these categories:\n{json.dumps(category_names)}\n\n"
        f"Return ONLY a JSON array of up to 3 category IDs that best match this channel. Example: [1, 5, 12]"
    )

    try:
        response = requests.post(
            f'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}',
            json={
                'contents': [{'parts': [{'text': prompt}]}],
                'generationConfig': {'temperature': 0.1},
            },
            timeout=10,
        )
        response.raise_for_status()
        text = response.json()['candidates'][0]['content']['parts'][0]['text']
        # Extract JSON array from response
        match = re.search(r'\[[\d,\s]+\]', text)
        if match:
            ids = json.loads(match.group())
            valid_ids = {c['id'] for c in categories}
            return [id for id in ids if id in valid_ids][:3]
    except Exception as e:
        logger.warning("Gemini suggestion failed: %s", e)

    return []


def heuristic_suggestions(subscription: Subscription, categories: list[dict]) -> list[int]:
    """Keyword-matching fallback for category suggestions."""
    title = (subscription.channel_title or '').lower()
    desc = (subscription.channel_description or '').lower()
    topics = subscription.topics or []

    text = f"{title} {desc} {' '.join(t.lower() for t in topics)}"

    scored = []
    for cat in categories:
        cat_name = cat['name'].lower()
        cat_words = cat_name.split()
        score = 0
        for word in cat_words:
            if len(word) > 2 and word in text:
                score += 1
        if score > 0:
            scored.append((cat['id'], score))

    scored.sort(key=lambda x: -x[1])
    return [id for id, _ in scored[:3]]
