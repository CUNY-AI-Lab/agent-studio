# Springshare LibGuides API

## Overview
API for a library's research guides, subject databases, and librarian contacts.
Use it to find guides by topic or subject, list the A–Z database collection, and
surface the right librarian for a subject.

## Authentication — handled by the host
This deployment uses OAuth 2.0 client credentials, but **the host handles auth
for you**. When LibGuides is configured, the host web-fetch helper acquires and
attaches `Authorization: Bearer <token>` on requests to the LibGuides API host,
and injects the required `site_id` query parameter server-side. Do NOT ask the
user for keys or the site ID, do NOT call the token endpoint, and do NOT add the
Authorization header or `site_id` yourself — just make the request.

If a LibGuides request returns an error indicating the API is not configured (or
a persistent 401), tell the user that research-guide lookup isn't available on
this deployment and offer to search the open web or suggest they browse the
library's guides site directly.

Make requests from codemode with `codemode.web_fetch({ url, format: 'json' })` —
direct `fetch()` is blocked. Parse the string body with `JSON.parse(res.body)`.

## Base URL
The API base (including the `/1.2` version segment) is the host's concern; you
issue requests against the region base, e.g. `https://lgapi-us.libapps.com/1.2`.
The host injects `site_id`, so you only supply the path and other parameters.

## Endpoints

### List Guides
```
GET /guides?status=1
```
- `status` — 1 = published, 0 = unpublished
- `subject_ids` — Filter by subject
- `group_ids` — Filter by group

### Get Single Guide
```
GET /guides/{guide_id}?expand=pages,boxes,assets
```
**expand** options: `pages`, `boxes`, `assets`.

### List Subjects
```
GET /subjects
```

### List Databases (A–Z)
```
GET /az
```

### List Librarians
```
GET /accounts
```

## Response Format

### Guides List
```json
[
  {
    "id": "123456",
    "name": "Research Guide Title",
    "description": "Guide description",
    "url": "https://libguides.example.edu/guide",
    "status": "1",
    "owner": {
      "id": "789",
      "first_name": "Jane",
      "last_name": "Librarian",
      "email": "jane@example.edu"
    },
    "subjects": [{ "id": "1", "name": "Biology" }]
  }
]
```

### Database List (A–Z)
```json
[
  {
    "id": "456",
    "name": "JSTOR",
    "description": "Full-text academic journals",
    "url": "https://www.jstor.org",
    "subjects": [{ "id": "1", "name": "Multidisciplinary" }]
  }
]
```

## Example Code (codemode)

### Get all published guides
```javascript
const res = await codemode.web_fetch({
  url: 'https://lgapi-us.libapps.com/1.2/guides?status=1',
  format: 'json',
});
const guides = JSON.parse(res.body);

if (!res.ok) {
  // If the error indicates LibGuides is not configured on this deployment,
  // tell the user and offer alternatives.
  return { error: guides };
}

return guides.map((g) => ({
  name: g.name,
  url: g.url,
  owner: g.owner ? `${g.owner.first_name} ${g.owner.last_name}` : null,
  subjects: g.subjects?.map((s) => s.name) || [],
}));
```

### Find guides by subject
```javascript
const subjRes = await codemode.web_fetch({
  url: 'https://lgapi-us.libapps.com/1.2/subjects',
  format: 'json',
});
const subjects = JSON.parse(subjRes.body);
const match = subjects.find((s) => s.name.toLowerCase().includes('biology'));

if (match) {
  const res = await codemode.web_fetch({
    url: `https://lgapi-us.libapps.com/1.2/guides?status=1&subject_ids=${match.id}`,
    format: 'json',
  });
  return JSON.parse(res.body);
}
```

### List databases (A–Z)
```javascript
const res = await codemode.web_fetch({
  url: 'https://lgapi-us.libapps.com/1.2/az',
  format: 'json',
});
const databases = JSON.parse(res.body);
return databases.map((db) => ({ name: db.name, description: db.description, url: db.url }));
```

## Common Use Cases
- List research guides, or find guides by subject area.
- Get the A–Z database list for a topic.
- Find the librarian contact for a subject.

## Source-forward practice
Guide answers should link the user to the guide itself: surface each guide's own
`url` (its permalink) so they can open it, and name the owning librarian and
subject when available. When recommending a database, include its LibGuides `url`
rather than describing it from memory. Never invent a guide or database URL —
if a record has no `url`, report its name and note that no direct link is
available. Render links as markdown (e.g. `[Sociology Research Guide](url)`),
never a raw URL.
