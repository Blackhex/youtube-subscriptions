---
name: quality-gate
description: "Quality gate assessment for YouTube Subscriptions Organizer implementation phases. Use when: evaluating whether a phase is complete, checking all acceptance criteria, verifying tests pass, reviewing code quality, deciding if implementation can proceed to the next phase."
---

# Quality Gate Assessment

## When to Use
- After an implementation phase is complete, before starting the next
- When deciding if code is ready to merge or proceed
- For phase acceptance testing

## Design References
- **Implementation Plan**: See [Implementation Plan](../../../docs/06-implementation-plan.md) for phase milestones
- **User Scenarios**: See [User Scenarios](../../../docs/05-user-scenarios.md) for acceptance criteria

## Quality Gate Procedure

### 1. Phase Completion Checklist
For each implementation phase from the [Implementation Plan](../../../docs/06-implementation-plan.md):

#### Phase 0: Project Setup
- [ ] Django project runs (`python manage.py runserver`)
- [ ] Vite dev server runs with API proxy working
- [ ] `requirements.txt` has all dependencies
- [ ] `package.json` has all frontend dependencies

#### Phase 1: Core Models
- [ ] All 6 models defined with correct fields and constraints
- [ ] Migrations created and applied successfully
- [ ] Model relationships work (Category tree, Subscription M:N, Video FK)
- [ ] Serializers produce correct JSON structure
- [ ] URL routing configured for DRF router

#### Phase 2: YouTube Service
- [ ] OAuth flow completes
- [ ] Data API v3 subscription fetch works
- [ ] InnerTube FEchannels supplement works
- [ ] Retry logic handles transient errors

#### Phase 3: Category API
- [ ] CRUD endpoints return correct status codes/data
- [ ] Tree query returns nested children with counts
- [ ] Circular parent validation works
- [ ] Reorder persists sort_order
- [ ] PocketTube export generates valid JSON
- [ ] PocketTube import creates categories and assignments

#### Phase 4: Subscription API
- [ ] Paginated listing with category filter works
- [ ] Assign/unassign updates SubscriptionCategory
- [ ] Delete triggers YouTube unsubscribe (if subscription_id set)
- [ ] AI suggestions return category IDs

#### Phase 5: Background Sync
- [ ] Full sync starts in background thread (returns 202)
- [ ] Concurrent sync prevented (returns 409)
- [ ] Status endpoint returns accurate progress
- [ ] Video sync is incremental

#### Phase 6: Feed System
- [ ] Feed CRUD works
- [ ] AND/OR category group filtering correct
- [ ] Type, duration, age, play state filters work
- [ ] Combined filters produce correct results
- [ ] Pagination on feed videos works

#### Phase 7: Queue & Cast
- [ ] Queue add (deduplicated), remove, reorder, clear work
- [ ] Create playlist from queue creates YouTube playlist
- [ ] Cast sends correct Lounge API sequence
- [ ] Refresh progress updates queue items

#### Phase 8: Playlist Management
- [ ] List playlists from YouTube
- [ ] CRUD playlist items
- [ ] Reorder playlist items
- [ ] Delete playlist on YouTube

#### Phases 9-14: React Frontend
- [ ] All sections render and switch correctly
- [ ] Each component matches design spec
- [ ] All hooks function correctly with API
- [ ] Drag-and-drop works in all three contexts
- [ ] Infinite scroll loads more data
- [ ] Cast integration connects and controls playback
- [ ] All 14 user scenarios pass end-to-end

### 2. Code Quality Metrics
- [ ] No TypeScript type errors (`npm run build` succeeds)
- [ ] No Python exceptions on standard flows
- [ ] No console errors in browser dev tools
- [ ] All unit tests pass
- [ ] All E2E tests pass (`cd frontend && npx playwright test`)
- [ ] No critical security issues
- [ ] Code review findings addressed

### 3. Gate Decision

| Rating | Criteria | Action |
|--------|----------|--------|
| **PASS** | All checklist items pass, tests green, no critical issues | Proceed to next phase |
| **PASS WITH NOTES** | Minor issues found, non-blocking | Proceed, track issues for later |
| **FAIL** | Critical issues, broken functionality, tests failing | Block until resolved |

## Output Format
```
## Quality Gate: Phase [N] — [Name]

### Checklist Results
- [x] Item passed
- [ ] ❌ Item failed — [reason]

### Test Results
- Backend: [X/Y passed]
- Frontend: [X/Y passed]
- E2E: [X/Y passed]

### Issues
1. **[Blocking/Non-blocking]** — [description]

### Decision: [PASS / PASS WITH NOTES / FAIL]
[Reasoning]
```
