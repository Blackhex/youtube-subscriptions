export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function timeAgo(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const difference = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (difference < 60) return 'just now';
  if (difference < 3600) return `${Math.floor(difference / 60)}m ago`;
  if (difference < 86400) return `${Math.floor(difference / 3600)}h ago`;
  if (difference < 2592000) return `${Math.floor(difference / 86400)}d ago`;
  return date.toLocaleDateString();
}