# mssqlOrm

SQL Server ORM. Proxy client. CRUD. Vector search. Middleware. Raw queries. Transactions.

## Features

-   **Proxy Client.** Model access. `db.modelName` syntax.
-   **CRUD.** `findMany`, `findFirst`, `findUnique`, `create`, `update`, `delete`, `upsert`.
-   **Advanced Queries.** OR/AND, nested relations, aggregates, `groupBy`.
-   **Vector Search.** Native SQL Server `VECTOR_DISTANCE`. In-memory fallback.
-   **Middleware.** Hook ORM operations: logging, auth, validation.
-   **Raw Queries.** `$queryRaw`, `$executeRaw`. Auto `NOLOCK`.
-   **Transactions.** `$transaction`. Rollback support.
-   **Schema Generator.** Parse `.mssql` files. Generate TypeScript/Python/.NET code.

## Quick Start

### Configuration

```bash
cp .env.example .env
# Edit .env. Set DATABASE_URL.
```

### Development Commands

```bash
# Generate code from schema
npm run generate

# Push schema to database
npm run db:push

# Pull schema from database
npm run db:pull

# Seed database
npm run db:seed

# Run tests
npm test
```

## Usage

```typescript
import { MssqlORM } from './mssqlOrm';

const db = new MssqlORM();

// CRUD Operations
const users = await db.user.findMany({
  where: { email: { contains: '@example.com' } },
  orderBy: { createdAt: 'desc' },
  take: 10,
});

const user = await db.user.create({
  data: { email: 'john@example.com', name: 'John' },
});

// Relations
const orders = await db.user.findMany({
  include: { orders: true },
});

// Vector Search
const similar = await db.document.vectorSearch({
  vector: [0.1, 0.2, 0.3],
  take: 5,
  distanceMetric: 'cosine',
});

// Transactions
await db.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { email: 'jane@example.com' } });
  await tx.order.create({ data: { userId: user.id, total: 100 } });
});

// Raw Queries
const results = await db.$queryRaw`SELECT * FROM users WHERE id = ${id}`;
```

## Schema Definition

Schema files: `.mssql`. Path: `mssqlSchema/`. SQL Server types.

```mssql
model User {
  id        NVARCHAR(1000) @id @default(uuid())
  email     NVARCHAR(255)  @unique
  name      NVARCHAR(255)?
  createdAt DATETIME2      @default(now())
  orders    Order[]

  @@map("users")
}

model Order {
  id        NVARCHAR(1000) @id @default(uuid())
  userId    NVARCHAR(1000)
  total     INT            @default(0)
  user      User           @relation(fields: [userId], references: [id])

  @@map("orders")
}
```

## Supported SQL Server Types

Type mapping: `.mssql` to TypeScript.

| Schema Type | TypeScript |
|-------------|------------|
| `NVARCHAR(n)`, `VARCHAR(n)`, `CHAR(n)`, `TEXT` | `string` |
| `INT`, `SMALLINT`, `TINYINT`, `FLOAT`, `REAL`, `DECIMAL`, `NUMERIC` | `number` |
| `BIGINT` | `number \| bigint` |
| `BIT` | `boolean` |
| `DATETIME`, `DATETIME2`, `DATE`, `TIME` | `Date` |
| `UNIQUEIDENTIFIER` | `string` |
| `VARBINARY`, `BINARY`, `IMAGE` | `Buffer` |

## Testing

```bash
# Unit tests
node test/unit.test.js

# Generator tests
node test/generator.test.js

# Smoke test
npm test
```

## License

MIT