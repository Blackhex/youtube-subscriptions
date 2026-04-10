from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Instructions for YouTube session setup.'

    def handle(self, *args, **options):
        self.stdout.write(
            'YouTube session is now managed via the browser extension.\n'
            'Install the extension from the extension/ directory:\n'
            '  1. Open chrome://extensions\n'
            '  2. Enable Developer Mode\n'
            '  3. Click "Load unpacked" and select the extension/ folder\n'
            '  4. Mark a video as watched in the app — cookies sync automatically'
        )
