# Staff & Shift Management System - Development Rules

## Project Overview

This is a universal staff and shift management system built with:
- **Database**: PostgreSQL with Drizzle ORM
- **Architecture**: Multi-tenant SaaS application
- **Key Features**: SCD Type 2 versioning, comprehensive audit logging, role-based access

## Critical Patterns to Follow

### 1. Database Operations

**ALWAYS use helper functions from `helpers/audit-logger.ts` for data modifications:**

```typescript
// ❌ WRONG - Direct database operations
await db.update(staff).set({ name: 'New Name' });

// ✅ CORRECT - Use audit helpers
import { updateWithAudit, createNewVersion } from './helpers/audit-logger';

// For regular updates (non-SCD tables or when not preserving history)
await updateWithAudit({
  table: staff,
  id: staffId,
  updates: { name: 'New Name' },
  entityType: 'staff',
  performedBy: userId,
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
});

// For SCD Type 2 tables (when preserving full history)
await createNewVersion({
  table: staff,
  currentId: staffId,
  updates: { name: 'New Name' },
  performedBy: userId,
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
});
```

**For shift assignment status changes:**

```typescript
// ✅ Use the specialized function that creates BOTH logs automatically
await updateAssignmentStatus({
  assignmentId,
  newStatus: 'accepted',
  message: 'Available!',
  changedByStaff: staffId,
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
});
// This creates BOTH shift_assignment_logs AND audit_logs entries
```

### 2. SCD Type 2 Tables

Tables with SCD Type 2 (history versioning):
- `organizations`
- `users`
- `roles`
- `staff`
- `staff_addresses`
- `shifts`

**Required fields:**
- `valid_from` (timestamp) - When this version became valid
- `valid_to` (timestamp, nullable) - When this version stopped being valid (NULL = current)
- `is_current` (boolean) - Is this the current version?
- `previous_version_id` (uuid, nullable) - Link to previous version

**Query patterns:**

```typescript
// Get current version
const current = await db.query.staff.findFirst({
  where: and(
    eq(staff.id, staffId),
    eq(staff.is_current, true)
  ),
});

// Get all versions (history)
const history = await getEntityHistory({ table: staff, entityId: staffId });

// Point-in-time query (state at specific date)
const staffAtDate = await db
  .select()
  .from(staff)
  .where(
    and(
      lte(staff.valid_from, specificDate),
      or(
        isNull(staff.valid_to),
        gte(staff.valid_to, specificDate)
      )
    )
  );
```

### 3. Database Schema Structure

**Core Entities:**
```
organizations (multi-tenant root)
  ├── users (managers/admins)
  ├── roles (custom roles per organization)
  ├── staff (employees/personnel)
  │   ├── staff_roles (many-to-many with roles)
  │   └── staff_addresses (SCD Type 2 address history)
  └── shifts (events/assignments)
      └── shift_assignments (staff assigned to shifts)
          └── shift_assignment_logs (status change history)

audit_logs (universal audit trail for ALL entities)
```

**Entity Types for audit_logs:**
- `organization`
- `user`
- `role`
- `staff`
- `shift`
- `shift_assignment`

### 4. Naming Conventions

**Database:**
- Tables: snake_case (e.g., `shift_assignments`)
- Columns: snake_case (e.g., `organization_id`)
- Enums: camelCase with "Enum" suffix (e.g., `responseStatusEnum`)

**TypeScript:**
- Files: kebab-case (e.g., `audit-logger.ts`)
- Functions: camelCase (e.g., `updateWithAudit`)
- Types/Interfaces: PascalCase
- Constants: SCREAMING_SNAKE_CASE

### 5. JSON Metadata Fields

Several tables have flexible `metadata` JSON fields. Common patterns:

**Staff metadata:**
```typescript
staff.metadata = {
  // Restaurant
  allergies: ['nuts', 'dairy'],
  languages: ['de', 'en', 'fr'],
  certifications: ['hygiene', 'first-aid'],
  
  // Band
  instruments: ['guitar', 'bass'],
  genres: ['rock', 'jazz'],
  hasOwnEquipment: true,
  
  // Event Agency
  driverLicense: true,
  securityCertificate: 'IHK §34a',
  availableEquipment: ['camera', 'drone'],
};
```

**Shift metadata:**
```typescript
shift.metadata = {
  expectedGuests: 80,
  menuType: 'à la carte',
  dresscode: 'uniform',
  clientName: 'Company XYZ',
  setupTime: '2 hours',
};
```

### 6. Security & Context

**ALWAYS capture context information:**

```typescript
// Required context for audit logging
const context = {
  performedBy: userId,           // Or performedByStaff
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
  metadata: {
    endpoint: req.path,
    method: req.method,
    // ... any additional context
  },
};
```

### 7. Transactions

**Use transactions for operations that modify multiple tables:**

```typescript
await db.transaction(async (tx) => {
  // Multiple operations here
  const shift = await tx.insert(shifts).values(...).returning();
  await tx.insert(shiftAssignments).values(...);
  await tx.insert(auditLogs).values(...);
});
```

### 8. Query Best Practices

**Use Drizzle's relational queries when possible:**

```typescript
// ✅ GOOD - Relational query with eager loading
const shift = await db.query.shifts.findFirst({
  where: eq(shifts.id, shiftId),
  with: {
    assignments: {
      with: {
        staff: true,
        role: true,
      },
    },
  },
});

// ❌ AVOID - Multiple separate queries
const shift = await db.query.shifts.findFirst(...);
const assignments = await db.query.shiftAssignments.findMany(...);
const staff = await db.query.staff.findMany(...);
```

### 9. Error Handling

```typescript
try {
  await updateWithAudit({...});
} catch (error) {
  if (error.message === 'Record not found') {
    // Handle not found
  }
  // Log error with context
  logger.error('Failed to update staff', {
    staffId,
    error: error.message,
    userId,
  });
  throw error;
}
```

### 10. Type Safety

**Import types from schema:**

```typescript
import { 
  type Staff, 
  type Shift, 
  type ShiftAssignment 
} from './schema';

// Use InferModel for type inference
type NewStaff = typeof staff.$inferInsert;
type StaffRow = typeof staff.$inferSelect;
```

## Do's and Don'ts

### ✅ DO

- Use audit-logger helper functions for ALL data modifications
- Capture IP address and user-agent for audit logs
- Use transactions for multi-table operations
- Query only current versions of SCD tables unless specifically requesting history
- Use Drizzle's relational queries with `with` for eager loading
- Include organization_id in all queries for multi-tenancy
- Handle nullable SCD fields (`valid_to`, `previous_version_id`)

### ❌ DON'T

- Don't use direct `db.insert/update/delete` without audit logging
- Don't query SCD tables without filtering for `is_current = true`
- Don't forget to set SCD fields when creating new versions
- Don't expose internal IDs in API responses without authorization checks
- Don't skip the organization_id filter - this breaks multi-tenancy
- Don't hardcode role names - they are organization-specific
- Don't forget that `updateAssignmentStatus` already creates audit logs

## Common Workflows

### Creating Staff with Audit

```typescript
import { createWithAudit } from './helpers/audit-logger';

const newStaff = await createWithAudit({
  table: staff,
  values: {
    organization_id: org.id,
    name: 'John Doe',
    email: 'john@example.com',
    phone: '+1234567890',
    primary_role_id: roleId,
  },
  entityType: 'staff',
  performedBy: userId,
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
});
```

### Updating with History (SCD Type 2)

```typescript
import { createNewVersion } from './helpers/audit-logger';

const updated = await createNewVersion({
  table: staff,
  currentId: staffId,
  updates: {
    name: 'Jane Doe',
    email: 'jane@example.com',
  },
  performedBy: userId,
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
});
// Old version is marked as historical, new version created
```

### Querying with Multi-Tenancy

```typescript
// ALWAYS filter by organization
const orgStaff = await db.query.staff.findMany({
  where: and(
    eq(staff.organization_id, currentOrgId),
    eq(staff.is_current, true),
    eq(staff.is_active, true)
  ),
  with: {
    primaryRole: true,
    roles: {
      with: { role: true },
    },
  },
});
```

### Shift Assignment with Status Tracking

```typescript
// 1. Create shift
const shift = await createWithAudit({
  table: shifts,
  values: {
    organization_id: org.id,
    created_by: userId,
    title: 'Friday Night Service',
    shift_date: new Date('2025-11-07'),
    start_time: new Date('2025-11-07T17:00:00'),
    end_time: new Date('2025-11-07T23:00:00'),
    status: 'published',
  },
  entityType: 'shift',
  performedBy: userId,
});

// 2. Assign staff
await db.insert(shiftAssignments).values([
  { shift_id: shift.id, staff_id: staff1.id, role_id: role1.id },
  { shift_id: shift.id, staff_id: staff2.id, role_id: role2.id },
]);

// 3. Staff responds (creates BOTH logs automatically)
await updateAssignmentStatus({
  assignmentId: assignment.id,
  newStatus: 'accepted',
  message: 'I can make it!',
  changedByStaff: staff1.id,
});
```

## Helper Functions Reference

**From `helpers/audit-logger.ts`:**

### SCD Type 2
- `createNewVersion()` - Create new version with full history
- `getEntityHistory()` - Get all versions chronologically
- `getCurrentVersion()` - Get current active version
- `updateStaffAddress()` - Update address with SCD Type 2

### Audit Logging
- `logAuditEvent()` - Manual audit log entry
- `createWithAudit()` - CREATE with auto-logging
- `updateWithAudit()` - UPDATE with auto-logging
- `deleteWithAudit()` - DELETE with auto-logging
- `getAuditLogsForEntity()` - Get audit history for entity
- `getOrganizationAuditLogs()` - Get org audit logs with filters

### Assignment Specific
- `updateAssignmentStatus()` - Update status (creates BOTH logs)
- `getAssignmentHistory()` - Get assignment change history
- `getAssignmentStatistics()` - Get assignment stats
- `formatAssignmentHistory()` - Format history for display

## Environment Variables

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_password
DB_NAME=staff_management
```

## Migration Commands

```bash
# Generate migration from schema changes
npx drizzle-kit generate

# Push schema to database
npx drizzle-kit push

# Run migrations
npx drizzle-kit migrate
```

## Industry-Specific Implementations

This system is designed to be industry-agnostic. Common use cases:
- 🎵 Music Bands - Musicians for gigs
- 🍽️ Restaurants - Service staff for shifts
- 🎉 Event Agencies - Event personnel
- 🏥 Healthcare - Nursing staff scheduling
- 🛡️ Security - Security personnel deployment

**Key flexibility points:**
- Custom roles per organization
- JSON metadata for industry-specific data
- Flexible shift/event structure

## When to Add Audit Context

**ALWAYS include context for:**
- User-initiated actions (CRUD operations)
- Status changes (especially assignments)
- Authentication/authorization events
- API calls that modify data

**Context should include:**
- `performedBy` (userId) OR `performedByStaff` (staffId)
- `ipAddress`
- `userAgent`
- Optional: `metadata` with additional context (endpoint, request ID, etc.)

---

**Last Updated:** 2025-10-30
**Schema Version:** 1.0
**Drizzle ORM:** Latest
**PostgreSQL:** 14+