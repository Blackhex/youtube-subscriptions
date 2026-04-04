# YouTube Subscriptions Organizer — Design Documents

## Overview

These design documents comprehensively describe the YouTube Subscriptions Organizer application — a **Django + React SPA** for managing YouTube subscriptions with categories, customizable video feeds, playlist management, a video play queue with Google Cast support, and AI-powered suggestions.

These documents are sufficient to rebuild the entire application from scratch.

## Document Index

| # | Document | Description |
|---|----------|-------------|
| 1 | [Architecture Overview](01-architecture-overview.md) | System diagram, technology stack (Django + DRF + React + Vite + TypeScript), key architecture decisions, file structure, authentication flow, concurrency model, external API dependencies |
| 2 | [Data Model](02-data-model.md) | Entity relationship diagram, Django model definitions with field types/constraints, through model for M:N, migration strategy (Django migrations), DRF serialization |
| 3 | [API Reference](03-api-reference.md) | Complete REST API documentation: ~40 endpoints implemented as DRF ViewSets and APIViews, URL configuration, error format |
| 4 | [Frontend Design](04-frontend-design.md) | UI/UX specification: layout, design system (colors, typography, Material UI icons), React component tree, custom hooks, TypeScript interfaces, @dnd-kit drag-and-drop, Cast integration, CSS architecture |
| 5 | [User Scenarios](05-user-scenarios.md) | Feature matrix (Django + React columns) and 14 detailed user scenarios covering every major workflow |
| 6 | [Implementation Plan](06-implementation-plan.md) | Step-by-step build plan across 15 phases: Django project setup, models + migrations, DRF API, React setup with Vite/TypeScript, component development, production build |

## Quick Stats

| Metric | Value |
|--------|-------|
| Backend Framework | Django + Django REST Framework |
| Frontend Framework | React 18 + TypeScript + Vite |
| Django Models | 6 (Category, Subscription, SubscriptionCategory, Video, QueueItem, Feed) |
| DRF ViewSets/Views | ~15 classes |
| API Endpoints | ~40 |
| React Components | ~25 |
| Custom Hooks | ~10 (useCategories, useSubscriptions, useFeeds, useQueue, usePlaylists, useSync, useCast, useToast, useConfirm, useInfiniteScroll) |
| External APIs | 4 (YouTube Data v3, InnerTube, Lounge, Gemini) |
| Drag-and-Drop Library | @dnd-kit (categories, queue, playlists) |
