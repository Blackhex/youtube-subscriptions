---
name: code-review
description: "Code review for YouTube Subscriptions Organizer. Use when: reviewing Python or TypeScript code quality, checking adherence to design docs, verifying Django/DRF patterns, reviewing React patterns, checking for security issues, verifying error handling, assessing code maintainability."
---

# Code Review

## When to Use
- Reviewing any implementation code for correctness and quality
- Verifying code matches the design documents
- Checking for security vulnerabilities (OWASP Top 10)
- Assessing code maintainability and readability

## Procedure

### 1. Design Compliance Check
Compare implementation against design docs:
- Models match [Data Model](../../../docs/02-data-model.md) field types, constraints, relationships
- API endpoints match [API Reference](../../../docs/03-api-reference.md) request/response formats
- Components match [Frontend Design](../../../docs/04-frontend-design.md) component tree and behavior
- User flows match [User Scenarios](../../../docs/05-user-scenarios.md)

### 2. Python/Django Review Checklist
- [ ] Models use correct field types and constraints from data model doc
- [ ] ForeignKey `on_delete` matches spec (CASCADE for all in this app)
- [ ] Serializers handle nested relationships correctly
- [ ] ViewSet actions use correct HTTP methods and status codes
- [ ] QuerySet filtering is efficient (no N+1 queries, use `select_related`/`prefetch_related`)
- [ ] Background sync uses `threading.Lock` for state access
- [ ] ThreadPoolExecutor limited to `max_workers=3`
- [ ] YouTube API calls use retry logic for transient errors
- [ ] File operations use safe paths (no path traversal in thumbnail caching)
- [ ] No hardcoded secrets — credentials from files only
- [ ] Error responses use consistent format: `{ "error": "message" }`

### 3. TypeScript/React Review Checklist
- [ ] Components are functional with hooks (no class components)
- [ ] TypeScript strict mode — no `any` types except where unavoidable (Cast SDK)
- [ ] All API responses properly typed
- [ ] useEffect cleanup for subscriptions, intervals, IntersectionObserver
- [ ] useCallback/useMemo where appropriate for performance
- [ ] Error states handled in hooks (try/catch, toast notifications)
- [ ] Accessibility: keyboard navigation for @dnd-kit, aria labels
- [ ] No memory leaks (interval cleanup, abort controllers)
- [ ] State updates don't cause unnecessary re-renders
- [ ] Async hook updates do not overwrite newer pagination state (`page`/`hasMore`) with stale responses

### 4. Security Checklist
- [ ] No SQL injection (Django ORM handles parameterization)
- [ ] No XSS (React escapes by default; no `dangerouslySetInnerHTML`)
- [ ] File upload validation in category import (check file type/size)
- [ ] Thumbnail download validates URL scheme (http/https only)
- [ ] No path traversal in thumbnail cache file operations
- [ ] CORS configured for local development only
- [ ] OAuth tokens not logged or exposed in API responses
- [ ] OAuth callback URL/code/state are never logged, echoed, persisted, or left in extension destination URLs
- [ ] Remote installed-app callback relay requires exact top-level loopback callback, configured HTTPS origin, current host permission, bounded I/O, and redirect refusal
- [ ] OAuth callback exchange, refresh, and logout generation races cannot recreate a deleted token
- [ ] Server-side YouTube OAuth is not mistaken for browser/API caller authentication

### 5. Consistency Checks
- [ ] All icons use @mui/icons-material (no Unicode emojis)
- [ ] CSS follows design system colors and typography
- [ ] Pagination format consistent across all endpoints
- [ ] Loading/error states handled in all async operations

## Output Format
Report findings as:
```
## Review: [file/component name]

### Passed ✓
- [items that look good]

### Issues Found
1. **[Severity: Critical/Major/Minor]** — [description]
   - File: [path#line]
   - Expected: [what it should be]
   - Actual: [what it is]

### Recommendations
- [optional improvements]
```
