from unittest.mock import patch, MagicMock

from django.test import TestCase

from subscriptions.models import Category, Subscription
from subscriptions.suggestions import get_suggestions, heuristic_suggestions


class HeuristicSuggestionsTest(TestCase):
    def setUp(self):
        self.cat_prog = Category.objects.create(name="Programming", sort_order=0)
        self.cat_music = Category.objects.create(name="Music Production", sort_order=1)
        self.cat_gaming = Category.objects.create(name="Gaming", sort_order=2)
        self.categories = list(Category.objects.all().values('id', 'name'))

    def test_returns_matching_categories_by_keyword(self):
        sub = Subscription.objects.create(
            channel_id="UC_heur1",
            channel_title="Python Programming Tutorials",
            channel_description="Learn programming with Python and JavaScript",
        )
        result = heuristic_suggestions(sub, self.categories)
        cat_ids = [c['id'] for c in self.categories]
        self.assertIn(self.cat_prog.id, result)

    def test_returns_empty_for_no_matches(self):
        sub = Subscription.objects.create(
            channel_id="UC_heur2",
            channel_title="Cooking with Chef",
            channel_description="Delicious recipes",
        )
        result = heuristic_suggestions(sub, self.categories)
        self.assertEqual(result, [])

    def test_max_three_results(self):
        # Create enough categories with matching keywords
        Category.objects.create(name="Python", sort_order=3)
        Category.objects.create(name="JavaScript", sort_order=4)
        categories = list(Category.objects.all().values('id', 'name'))
        sub = Subscription.objects.create(
            channel_id="UC_heur3",
            channel_title="Programming Python JavaScript Gaming Music Production",
            channel_description="All topics",
        )
        result = heuristic_suggestions(sub, categories)
        self.assertLessEqual(len(result), 3)

    def test_uses_topics_for_matching(self):
        sub = Subscription.objects.create(
            channel_id="UC_heur4",
            channel_title="Some Channel",
            topics=["programming", "code"],
        )
        result = heuristic_suggestions(sub, self.categories)
        self.assertIn(self.cat_prog.id, result)


class GetSuggestionsTest(TestCase):
    def setUp(self):
        self.cat = Category.objects.create(name="Programming", sort_order=0)
        self.sub = Subscription.objects.create(
            channel_id="UC_sug1",
            channel_title="Python Programming",
            channel_description="Programming tutorials",
        )

    @patch('subscriptions.suggestions.os.path.exists', return_value=False)
    def test_falls_back_to_heuristic_when_no_gemini_key(self, mock_exists):
        result = get_suggestions(self.sub)
        # Should use heuristic, find "Programming" match
        self.assertIn(self.cat.id, result)

    def test_returns_empty_when_no_categories(self):
        Category.objects.all().delete()
        result = get_suggestions(self.sub)
        self.assertEqual(result, [])

    @patch('subscriptions.suggestions.os.path.exists', return_value=True)
    @patch('builtins.open', create=True)
    @patch('subscriptions.suggestions.requests.post')
    def test_gemini_success(self, mock_post, mock_open, mock_exists):
        mock_open.return_value.__enter__ = lambda s: MagicMock(read=lambda: 'fake-key', strip=lambda: 'fake-key')
        mock_open.return_value.__exit__ = MagicMock(return_value=False)

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            'candidates': [{
                'content': {
                    'parts': [{'text': f'[{self.cat.id}]'}]
                }
            }]
        }
        mock_post.return_value = mock_response

        result = get_suggestions(self.sub)
        self.assertIn(self.cat.id, result)
