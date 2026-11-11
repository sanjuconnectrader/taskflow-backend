# TaskFlow API

Base URL: `/api/v1`. JSON requests use `Content-Type: application/json`. Browser clients send `credentials: include` and `X-TaskFlow-Request: 1` on writes. Native clients request `native:true` at login/registration and send `Authorization: Bearer <opaque-session>`. Store native sessions with OS-backed storage only. All production calls use HTTPS.

Success payloads are the documented resource/list or `{ok:true}`; error payloads are `{error:{message,details?}}`. Validation: 400; authentication: 401; forbidden workspace/role: 403; missing scoped resource: 404; duplicates/stale task version: 409. IDs are UUIDs. All dates with time are UTC ISO timestamps. Deadlines are validated `YYYY-MM-DD` strings and never shifted by timezone.

`GET /health` (outside `/api/v1`) verifies database connectivity. Interactive OpenAPI overview is at `/docs`; `/api/v1/openapi.json` lists the core API. This document is the complete implemented route inventory.

## Authentication and recovery

| Method / path | Body / result |
| --- | --- |
| POST `/auth/register` | `{username,email,password,confirmPassword,acceptedTerms:true,native?:boolean}` → `{user,token?}`, 201; creates owner workspace |
| POST `/auth/login` | `{email,password,native?:boolean}` → `{user,token?}` |
| GET `/auth/me` | Safe profile DTO |
| POST `/auth/logout` | Revoke current session |
| POST `/auth/logout-all` | Revoke all user sessions |
| GET `/auth/sessions` | `{id,device,createdAt,expiresAt}[]` (no tokens/hashes) |
| POST `/auth/password` | `{currentPassword,password,confirmPassword}`; revokes all sessions |
| PATCH `/auth/profile` | `{username?,displayName?,preferences?:{theme?,reminders?,notifications?}}` |
| POST `/recovery/request` | `{email,explanation?}` → same generic 202 for known/unknown accounts |
| GET `/recovery/queue` | Eligible pending requests for authorized admin/operator |
| POST `/recovery/:id/approve` | `{verified:true,verificationNotes}` (≥30 chars); returns single-use authorization once |
| POST `/recovery/reset` | `{authorization,password,confirmPassword}`; consumes authorization, revokes all sessions |

Passwords require 12–128 characters. Username is normalized lowercase with 3–32 letters/numbers/underscores. Email is lowercase. Registration cannot grant platform privileges. Recovery operators must follow the independent identity checks in DEPLOYMENT.md. Tokens must never appear in URLs, logs, or public channels.

## Workspace scope

`GET /workspaces` → memberships including workspace and role. `POST /workspaces {name,description?}` creates a new owner workspace. Every following operation checks active membership server-side. All workspace projects are visible to all its members; there is no private-project ACL in this version.

Prefix `W = /workspaces/:wid`:

| Method / path | Authorization / body |
| --- | --- |
| PATCH `W` | Owner; `{name?,description?,archived?}` |
| DELETE `W` | Owner; `{confirmation:"exact workspace name"}`; cascades workspace content |
| GET `W/members` | Members with safe profile DTOs |
| POST `W/members` | Owner/Admin; `{email,role:"MEMBER"|"VIEWER"|"ADMIN"}`; only Owner can appoint Admin. Unregistered emails receive 422 |
| PATCH `W/members/:uid` | Owner only, non-owner targets; `{role}` |
| DELETE `W/members/:uid` | Owner/Admin, cannot remove owner or peer admin; removes task assignments and workspace socket access |
| GET `W/projects` | Project list including task counts |
| POST `W/projects` | Owner/Admin; `{name,description?,color?,dueDate?}` |
| PATCH `W/projects/:pid` | Owner/Admin; any project creation fields plus `archived?` |
| DELETE `W/projects/:pid` | Owner/Admin; deletes its tasks and comments |
| GET `W/tasks` | `{items,total,page,limit}`; query `page`, `limit` ≤200, `search`, `projectId`, `status`, `assigneeId`, `archived=true/false` |
| POST `W/tasks` | Owner/Admin/Member; task body below |
| GET `W/tasks/:tid` | Safe task DTO with project, assignees, checklist |
| PATCH `W/tasks/:tid` | Owner/Admin/Member; partial task fields plus required current `version`; 409 if stale |
| DELETE `W/tasks/:tid` | Creator or Owner/Admin; permanently deletes task subtree/comments |
| GET `W/activity` | Latest 50 activity records |
| GET `W/comments` | Latest 100 comments, optionally scoped by `taskId` or `projectId` |
| POST `W/comments` | Writer; `{body,taskId?,projectId?}`, target required; @username mentions notify workspace members |
| PATCH `W/comments/:cid` | Own comment only; `{body}` |
| DELETE `W/comments/:cid` | Own comment only |
| GET `W/notifications` | Current user's latest 100 workspace notifications |
| POST `W/notifications/read` | Current user including viewers; `{id?}` (omit ID for all) |
| GET `W/search?q=...` | Workspace-scoped tasks, projects, people, confirmed file metadata; max 10 per group |

Task body:

```json
{
  "title": "Review release notes",
  "description": "Plain text with context and links",
  "projectId": "a-project-uuid",
  "status": "TODO",
  "priority": "MEDIUM",
  "dueDate": "2026-11-15",
  "startDate": null,
  "assigneeIds": [],
  "tags": ["release"],
  "checklist": [{"text":"Check screenshots","done":false}],
  "parentId": null
}
```

Statuses: TODO, IN_PROGRESS, IN_REVIEW, COMPLETED, CANCELLED. Priorities: LOW, MEDIUM, HIGH, URGENT. Description is text, never interpreted as HTML. Assignees must belong to the workspace. Parent tasks and subtasks must share the project; one subtask level is allowed. PATCH `{archived:true,version:currentVersion}` archives a task; false restores. Checklist and assignee arrays replace the existing arrays atomically. Task completion sets/clears `completedAt`. Concurrent changes require explicit reload and retry.

## Reports and files

`GET /reports/:wid?today=YYYY-MM-DD&from=YYYY-MM-DD&to=YYYY-MM-DD&projectId=UUID&memberId=UUID&format=json|csv`. `today` is required and should be the user's local date; creation-time date range is UTC. The response contains totals, completion rate, status/priority/project groups, completion timeline and member workload. CSV exports authorized rows and neutralizes spreadsheet formulas. No seed-derived counts are embedded in the UI.

| Method / path | Behavior |
| --- | --- |
| GET `/files/:wid` | `{enabled,items}` for confirmed private file metadata |
| POST `/files/:wid/upload` | Writer; `{taskId,name,mime,size}` → `{id,url}`; signed PUT expires after 120 seconds |
| POST `/files/:wid/:fid/confirm` | Uploader; verifies object size, MIME and basic magic bytes before publishing metadata |
| GET `/files/:wid/:fid/download` | Member; returns attachment-only signed URL expiring after 60 seconds |
| DELETE `/files/:wid/:fid` | Uploader or Owner/Admin; deletes private object and metadata |

Allowlisted extensions and MIME pairs: PDF, PNG, JPEG and text; max 10 MiB. All other uploads fail. Presigned URLs are capabilities valid until expiration; do not share them. Private bucket credentials exist only on the server. File streaming/preview, malware scanning, and full object orphan cleanup are not implemented.

## Socket.IO

Connect at the API origin, using the cookie session or `auth:{token}`. The server validates session expiration and allowed origin. Emit `workspace:join` with a workspace UUID; the optional acknowledgement is `{ok:true|false}`. Joining rechecks database membership and leaves the previous workspace room. Client receives `invalidate` after changes and refetches authorized REST data. Events do not grant write authority and are not a persistent data source. Reconnect refetches all active queries. Session validity is rechecked every 30 seconds; removed members leave the workspace room immediately. Use a Redis adapter for multi-node scaling.
