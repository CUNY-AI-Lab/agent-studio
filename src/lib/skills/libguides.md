# Springshare LibGuides API

## Overview
API for accessing library research guides, databases, and assets.
**Requires OAuth 2.0 client credentials.**

## Base URL
```
https://lgapi-us.libapps.com/1.2
```
(Check env('LIBGUIDES_BASE_URL') - varies by region)

## Authentication

LibGuides uses OAuth 2.0 Client Credentials:

```javascript
const siteId = env('LIBGUIDES_SITE_ID');
const clientId = env('LIBGUIDES_CLIENT_ID');
const clientSecret = env('LIBGUIDES_CLIENT_SECRET');
const baseUrl = env('LIBGUIDES_BASE_URL');

// Get access token
const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
});
const { access_token } = await tokenRes.json();
```

## Endpoints

### List Guides
```
GET /guides?site_id={siteId}&status=1
```

**Parameters:**
- `site_id` - Your LibGuides site ID (required)
- `status` - 1 = published, 0 = unpublished
- `subject_ids` - Filter by subject
- `group_ids` - Filter by group

### Get Single Guide
```
GET /guides/{guide_id}?site_id={siteId}&expand=pages,boxes,assets
```

**expand options:**
- `pages` - Include page content
- `boxes` - Include box content
- `assets` - Include linked assets

### List Subjects
```
GET /subjects?site_id={siteId}
```

### List Databases (A-Z)
```
GET /az?site_id={siteId}
```

### List Librarians
```
GET /accounts?site_id={siteId}
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
    "created": "2024-01-15 10:30:00",
    "updated": "2024-06-01 14:22:00",
    "owner": {
      "id": "789",
      "first_name": "Jane",
      "last_name": "Librarian",
      "email": "jane@example.edu"
    },
    "subjects": [
      { "id": "1", "name": "Biology" }
    ]
  }
]
```

### Database List (A-Z)
```json
[
  {
    "id": "456",
    "name": "JSTOR",
    "description": "Full-text academic journals",
    "url": "https://www.jstor.org",
    "enable_proxy": "1",
    "subjects": [
      { "id": "1", "name": "Multidisciplinary" }
    ]
  }
]
```

## Example Code

### Get All Published Guides
```javascript
const siteId = env('LIBGUIDES_SITE_ID');
const clientId = env('LIBGUIDES_CLIENT_ID');
const clientSecret = env('LIBGUIDES_CLIENT_SECRET');
const baseUrl = env('LIBGUIDES_BASE_URL');

// Get token
const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
});
const { access_token } = await tokenRes.json();

// Get guides
const guidesRes = await fetch(`${baseUrl}/guides?site_id=${siteId}&status=1`, {
  headers: { 'Authorization': `Bearer ${access_token}` }
});
const guides = await guidesRes.json();

return guides.map(g => ({
  name: g.name,
  url: g.url,
  owner: `${g.owner.first_name} ${g.owner.last_name}`,
  subjects: g.subjects?.map(s => s.name)
}));
```

### Get Databases
```javascript
// After getting access_token...
const dbRes = await fetch(`${baseUrl}/az?site_id=${siteId}`, {
  headers: { 'Authorization': `Bearer ${access_token}` }
});
const databases = await dbRes.json();

return databases.map(db => ({
  name: db.name,
  description: db.description,
  url: db.url
}));
```

### Search Guides by Subject
```javascript
// First get subjects
const subjectsRes = await fetch(`${baseUrl}/subjects?site_id=${siteId}`, {
  headers: { 'Authorization': `Bearer ${access_token}` }
});
const subjects = await subjectsRes.json();

// Find subject ID
const biology = subjects.find(s => s.name.toLowerCase().includes('biology'));
if (biology) {
  // Get guides for that subject
  const guidesRes = await fetch(
    `${baseUrl}/guides?site_id=${siteId}&status=1&subject_ids=${biology.id}`,
    { headers: { 'Authorization': `Bearer ${access_token}` } }
  );
  const guides = await guidesRes.json();
  return guides;
}
```

## Environment Variables
```
LIBGUIDES_SITE_ID       - Your site ID
LIBGUIDES_CLIENT_ID     - OAuth client ID
LIBGUIDES_CLIENT_SECRET - OAuth client secret
LIBGUIDES_BASE_URL      - API base URL
```

## Common Use Cases
- List all research guides
- Find guides by subject area
- Get database A-Z list
- Find librarian contact info
- Extract guide content for analysis
