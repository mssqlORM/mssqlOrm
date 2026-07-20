import sql from "mssql";
import { An5Adapter } from "an5-adapters";
import { randomUUID } from "crypto";
import { logger } from "@an5/lib/logger";
import { An5 } from "an5-client/typescript";

import { modelToTable, relationMap, RelationDef, modelFields } from "an5-client/typescript/an5Metadata";

type ExecutorFn = (queryText: string, params?: Record<string, any>) => Promise<any[]>;

let adapter: An5Adapter | null = null;

async function getAdapter(): Promise<An5Adapter> {
  if (!adapter) {
    adapter = new An5Adapter({ connectionString: process.env.DATABASE_URL! });
    await adapter.$connect();
  }
  return adapter;
}

async function execQuery(queryText: string, params?: Record<string, any>): Promise<any[]> {
  const a = await getAdapter();
  return a.exec(queryText, params);
}

function parseWhere(modelName: string, where: any, params: Record<string, any>, prefix = ""): string {
  if (!where) return "";
  const conditions: string[] = [];

  const cleanWhere: Record<string, any> = {};
  for (const [key, value] of Object.entries(where)) {
    if (
      key.includes("_") &&
      value &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !(value as any).in &&
      !(value as any).contains &&
      !(value as any).not &&
      !(value as any).gte &&
      !(value as any).lte &&
      !(value as any).gt &&
      !(value as any).lt
    ) {
      Object.assign(cleanWhere, value);
    } else {
      cleanWhere[key] = value;
    }
  }

  for (const [key, value] of Object.entries(cleanWhere)) {
    if (key === "OR" && Array.isArray(value)) {
      const orConditions = value.map((subWhere, idx) => parseWhere(modelName, subWhere, params, `${prefix}or_${idx}_`));
      const filtered = orConditions.filter(Boolean);
      if (filtered.length > 0) {
        conditions.push(`(${filtered.join(" OR ")})`);
      }
    } else if (key === "AND" && Array.isArray(value)) {
      const andConditions = value.map((subWhere, idx) => parseWhere(modelName, subWhere, params, `${prefix}and_${idx}_`));
      const filtered = andConditions.filter(Boolean);
      if (filtered.length > 0) {
        conditions.push(`(${filtered.join(" AND ")})`);
      }
    } else {
      const modelRelations = relationMap[modelName];
      const relation = modelRelations?.[key];

      if (relation) {
        // Relation subquery
        const relationTable = modelToTable[relation.modelName];
        const subParams: Record<string, any> = {};

        let subWhere: any = value;
        let op = "some"; // default
        if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
          if (value.some) {
            subWhere = value.some;
            op = "some";
          } else if (value.none) {
            subWhere = value.none;
            op = "none";
          } else if (value.every) {
            subWhere = value.every;
            op = "every";
          }
        }

        const subWhereSql = parseWhere(relation.modelName, subWhere, subParams, `${prefix}${key}_`);
        Object.assign(params, subParams);

        if (subWhereSql) {
          if (relation.relationType === "one") {
            if (op === "none") {
              conditions.push(`${relation.foreignKey} NOT IN (SELECT ${relation.localKey} FROM ${relationTable} WITH (NOLOCK) WHERE ${subWhereSql})`);
            } else {
              conditions.push(`${relation.foreignKey} IN (SELECT ${relation.localKey} FROM ${relationTable} WITH (NOLOCK) WHERE ${subWhereSql})`);
            }
          } else {
            if (op === "none") {
              conditions.push(`${relation.localKey} NOT IN (SELECT ${relation.foreignKey} FROM ${relationTable} WITH (NOLOCK) WHERE ${subWhereSql})`);
            } else {
              conditions.push(`${relation.localKey} IN (SELECT ${relation.foreignKey} FROM ${relationTable} WITH (NOLOCK) WHERE ${subWhereSql})`);
            }
          }
        }
      } else {
        const paramName = `${prefix}${key}`;
        if (value && typeof value === "object" && !(value instanceof Date)) {
          const ops = Object.entries(value);
          for (const [op, opVal] of ops) {
            if (op === "in" && Array.isArray(opVal)) {
              if (opVal.length === 0) {
                conditions.push("1 = 0");
              } else {
                const inParams: string[] = [];
                opVal.forEach((item, idx) => {
                  const inParamName = `${paramName}_in_${idx}`;
                  inParams.push(`@${inParamName}`);
                  params[inParamName] = item;
                });
                conditions.push(`${key} IN (${inParams.join(", ")})`);
              }
            } else if (op === "notIn" && Array.isArray(opVal)) {
              if (opVal.length === 0) {
                // NOT IN empty list is always true, but let's be safe
                conditions.push("1 = 1");
              } else {
                const inParams: string[] = [];
                opVal.forEach((item, idx) => {
                  const inParamName = `${paramName}_notin_${idx}`;
                  inParams.push(`@${inParamName}`);
                  params[inParamName] = item;
                });
                conditions.push(`${key} NOT IN (${inParams.join(", ")})`);
              }
            } else if (op === "contains") {
              conditions.push(`${key} LIKE @${paramName}_contains`);
              params[`${paramName}_contains`] = `%${opVal}%`;
            } else if (op === "startsWith") {
              conditions.push(`${key} LIKE @${paramName}_startsWith`);
              params[`${paramName}_startsWith`] = `${opVal}%`;
            } else if (op === "endsWith") {
              conditions.push(`${key} LIKE @${paramName}_endsWith`);
              params[`${paramName}_endsWith`] = `%${opVal}`;
            } else if (op === "not") {
              conditions.push(`${key} <> @${paramName}_not`);
              params[`${paramName}_not`] = opVal;
            } else if (op === "gte") {
              conditions.push(`${key} >= @${paramName}_gte`);
              params[`${paramName}_gte`] = opVal;
            } else if (op === "lte") {
              conditions.push(`${key} <= @${paramName}_lte`);
              params[`${paramName}_lte`] = opVal;
            } else if (op === "gt") {
              conditions.push(`${key} > @${paramName}_gt`);
              params[`${paramName}_gt`] = opVal;
            } else if (op === "lt") {
              conditions.push(`${key} < @${paramName}_lt`);
              params[`${paramName}_lt`] = opVal;
            }
          }
        } else {
          if (value === null) {
            conditions.push(`${key} IS NULL`);
          } else {
            conditions.push(`${key} = @${paramName}`);
            params[paramName] = value;
          }
        }
      }
    }
  }

  return conditions.join(" AND ");
}

function buildOrderBy(orderBy: any): string {
  if (!orderBy) return "";
  const orderClauses: string[] = [];
  const orderByArr = Array.isArray(orderBy) ? orderBy : [orderBy];

  for (const orderObj of orderByArr) {
    if (orderObj && typeof orderObj === "object") {
      for (const [k, dir] of Object.entries(orderObj)) {
        const dirStr = typeof dir === "string" ? dir.toUpperCase() : "ASC";
        orderClauses.push(`${k} ${dirStr}`);
      }
    }
  }
  return orderClauses.length > 0 ? ` ORDER BY ` + orderClauses.join(", ") : "";
}

function projectFields(row: any, select: any) {
  if (!row || !select) return row;
  const projected: any = {};
  for (const [key, val] of Object.entries(select)) {
    if (val) {
      projected[key] = row[key];
    }
  }
  if (row._count) {
    projected._count = row._count;
  }
  return projected;
}

// Helper to batch-query and resolve relationships
async function resolveIncludes(modelName: string, rows: any[], include: any, executor: ExecutorFn) {
  if (!rows || rows.length === 0 || !include) return;

  const modelRelations = relationMap[modelName];
  if (!modelRelations) return;

  for (const [key, value] of Object.entries(include)) {
    if (!value) continue;

    const relation = modelRelations[key];
    if (!relation) {
      if (key === "_count" && value && typeof value === "object") {
        const countFields = Object.keys((value as any).select || {});
        for (const countField of countFields) {
          const rel = modelRelations[countField];
          if (rel) {
            const relTable = modelToTable[rel.modelName];
            const localKeys = rows.map(r => r[rel.localKey]).filter(Boolean);
            if (localKeys.length === 0) {
              rows.forEach(r => { r._count = { ...r._count, [countField]: 0 }; });
              continue;
            }

            const sqlText = `
              SELECT ${rel.foreignKey} as parentId, COUNT(*) as count 
              FROM ${relTable} WITH (NOLOCK)
              WHERE ${rel.foreignKey} IN (${localKeys.map((_, i) => `@lk_${i}`).join(", ")})
              GROUP BY ${rel.foreignKey}
            `;
            const countParams: Record<string, any> = {};
            localKeys.forEach((lk, i) => { countParams[`lk_${i}`] = lk; });

            const counts = await executor(sqlText, countParams);
            const countMap = new Map(counts.map((c: any) => [c.parentId, c.count]));

            rows.forEach(r => {
              if (!r._count) r._count = {};
              r._count[countField] = countMap.get(r[rel.localKey]) || 0;
            });
          }
        }
      }
      continue;
    }

    const relTable = modelToTable[relation.modelName];
    const isMany = relation.relationType === "many";
    const matchKey = relation.relationType === "one" ? relation.foreignKey : relation.localKey;
    const searchKey = relation.relationType === "one" ? relation.localKey : relation.foreignKey;

    const keys = rows.map(r => r[matchKey]).filter(Boolean);
    if (keys.length === 0) {
      rows.forEach(r => { r[key] = isMany ? [] : null; });
      continue;
    }

    const uniqueKeys = Array.from(new Set(keys));
    let relCols = "*";
    if (value && typeof value === "object" && (value as any).select) {
      const subSelect = (value as any).select;
      const subRelations = relationMap[relation.modelName] || {};
      const selectedSubCols = Object.keys(subSelect)
        .filter(k => subSelect[k] && !subRelations[k])
        .map(k => `[${k}]`);
      if (selectedSubCols.length > 0) {
        if (!selectedSubCols.includes(`[${searchKey}]`)) {
          selectedSubCols.push(`[${searchKey}]`);
        }
        relCols = selectedSubCols.join(", ");
      }
    }

    let sqlText = `SELECT ${relCols} FROM ${relTable} WITH (NOLOCK) WHERE ${searchKey} IN (${uniqueKeys.map((_, i) => `@k_${i}`).join(", ")})`;
    const subParams: Record<string, any> = {};
    uniqueKeys.forEach((k, i) => { subParams[`k_${i}`] = k; });

    if (value && typeof value === "object") {
      const subArgs = value as any;
      if (subArgs.orderBy) {
        sqlText += buildOrderBy(subArgs.orderBy);
      }
    }

    const relatedRows = await executor(sqlText, subParams);

    if (value && typeof value === "object" && (value as any).select) {
      relatedRows.forEach((r, idx) => {
        relatedRows[idx] = projectFields(r, (value as any).select);
      });
    }

    if (value && typeof value === "object" && (value as any).include) {
      await resolveIncludes(relation.modelName, relatedRows, (value as any).include, executor);
    }

    const groupMap = new Map<any, any[]>();
    relatedRows.forEach((r: any) => {
      const k = r[searchKey];
      if (!groupMap.has(k)) groupMap.set(k, []);
      groupMap.get(k)!.push(r);
    });

    rows.forEach(r => {
      const k = r[matchKey];
      const matches = groupMap.get(k) || [];
      if (isMany) {
        r[key] = matches;
      } else {
        r[key] = matches[0] || null;
      }
    });
  }
}

// Table query executor client class
class TableClient<T = any> {
  constructor(
    private modelName: string,
    private tableName: string,
    private executor: ExecutorFn,
    private orm: An5ORM
  ) { }

  async findMany(args?: any): Promise<T[]> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'findMany', args }, async (params) => {
      const { args: finalArgs } = params;
      const hasSkip = finalArgs?.skip !== undefined && finalArgs?.skip !== null;

      let cols = "*";
      if (finalArgs?.select) {
        const modelRelations = relationMap[this.modelName] || {};
        const selectedCols = Object.keys(finalArgs.select)
          .filter(k => finalArgs.select[k] && !modelRelations[k])
          .map(k => `[${k}]`);
        if (selectedCols.length > 0) {
          cols = selectedCols.join(", ");
        }
      }

      let sqlText = "SELECT";
      if (finalArgs?.take && !hasSkip) {
        sqlText += ` TOP (${finalArgs.take})`;
      }
      sqlText += ` ${cols} FROM ${this.tableName} WITH (NOLOCK)`;

      const p: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, finalArgs?.where, p);
      if (whereSql) {
        sqlText += ` WHERE ${whereSql}`;
      }

      if (finalArgs?.orderBy) {
        sqlText += buildOrderBy(finalArgs.orderBy);
      } else if (hasSkip) {
        // OFFSET requires an ORDER BY clause in SQL Server
        sqlText += " ORDER BY (SELECT NULL)";
      }

      if (hasSkip) {
        sqlText += ` OFFSET ${finalArgs.skip} ROWS`;
        if (finalArgs?.take) {
          sqlText += ` FETCH NEXT ${finalArgs.take} ROWS ONLY`;
        }
      }

      const rows = await this.executor(sqlText, p);
      if (finalArgs?.select) {
        rows.forEach((r, idx) => {
          rows[idx] = projectFields(r, finalArgs.select);
        });
      }
      if (finalArgs?.include) {
        await resolveIncludes(this.modelName, rows, finalArgs.include, this.executor);
      }
      return rows as T[];
    });
  }

  async findFirst(args?: any): Promise<T | null> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'findFirst', args }, async (params) => {
      const rows = await this.findMany({ ...params.args, take: 1 });
      return rows[0] || null;
    });
  }

  async findUnique(args?: any): Promise<T | null> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'findUnique', args }, async (params) => {
      return this.findFirst(params.args);
    });
  }

  async count(args?: any): Promise<number> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'count', args }, async (params) => {
      const { args: finalArgs } = params;
      let sqlText = `SELECT COUNT(*) as count FROM ${this.tableName} WITH (NOLOCK)`;
      const p: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, finalArgs?.where, p);
      if (whereSql) {
        sqlText += ` WHERE ${whereSql}`;
      }
      const result = await this.executor(sqlText, p);
      return result[0]?.count || 0;
    });
  }

  private async handleNestedWrites(data: any, parentId: any) {
    const modelRelations = relationMap[this.modelName] || {};
    for (const [key, value] of Object.entries(data)) {
      const relation = modelRelations[key];
      if (!relation || !value || typeof value !== "object" || (value instanceof Date)) continue;

      const relTableClient = this.orm[relation.modelName];
      if (!relTableClient) continue;

      const nestedOps = value as any;

      // Handle deleteMany (an5Orm-style)
      if (nestedOps.deleteMany) {
        const deleteWhere = Array.isArray(nestedOps.deleteMany) ? { OR: nestedOps.deleteMany } : nestedOps.deleteMany;
        // Scope deletion to parent
        const scopedWhere = { ...deleteWhere, [relation.foreignKey]: parentId };
        await relTableClient.deleteMany({ where: scopedWhere });
      }

      // Handle create
      if (nestedOps.create) {
        const createItems = Array.isArray(nestedOps.create) ? nestedOps.create : [nestedOps.create];
        for (const item of createItems) {
          // Inject parent ID
          const itemData = { ...item, [relation.foreignKey]: parentId };
          await relTableClient.create({ data: itemData });
        }
      }

      // Handle connect
      if (nestedOps.connect) {
        const connectItems = Array.isArray(nestedOps.connect) ? nestedOps.connect : [nestedOps.connect];
        for (const item of connectItems) {
          if (relation.relationType === "many") {
            await relTableClient.update({
              where: item,
              data: { [relation.foreignKey]: parentId }
            });
          }
        }
      }
    }
  }

  async create(args: any): Promise<T> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'create', args }, async (params) => {
      const { args: finalArgs } = params;
      try {
        const data = { ...finalArgs.data };

        // Extract nested writes
        const nestedData: Record<string, any> = {};
        const modelRelations = relationMap[this.modelName] || {};
        for (const key of Object.keys(data)) {
          if (modelRelations[key]) {
            nestedData[key] = data[key];
            delete data[key];
          }
        }

        if (!data.id && modelFields[this.modelName]?.id?.ts === "string") {
          data.id = randomUUID();
        }
        const now = new Date();
        if (!data.createdAt && modelFields[this.modelName]?.createdAt) data.createdAt = now;
        if (!data.updatedAt && modelFields[this.modelName]?.updatedAt) data.updatedAt = now;

        // Handle one-relation connect where we hold the FK
        for (const [key, value] of Object.entries(nestedData)) {
          const rel = modelRelations[key];
          if (rel && rel.relationType === "one" && (value as any).connect) {
            const connectObj = (value as any).connect;
            const targetId = connectObj.id || Object.values(connectObj)[0];
            data[rel.foreignKey] = targetId;
          }
        }

        const keys = Object.keys(data);
        const columns = keys.map(k => `[${k}]`).join(", ");
        const placeholders = keys.map(k => `@${k}`).join(", ");

        const sqlText = `INSERT INTO ${this.tableName} (${columns}) OUTPUT inserted.* VALUES (${placeholders})`;
        const rows = await this.executor(sqlText, data);
        const createdRow = rows[0];

        if (!createdRow) {
          throw new Error("Failed to insert record and retrieve output");
        }

        const pkField = ("id" in createdRow) ? "id" : Object.keys(createdRow).find(k => k.endsWith("_id"));
        const insertedId = pkField ? createdRow[pkField] : undefined;

        // Process other nested writes
        await this.handleNestedWrites(nestedData, insertedId);

        const created = await this.findUnique({
          where: pkField ? { [pkField]: insertedId } : {},
          include: finalArgs.include
        });
        if (!created) {
          throw new Error(`Failed to retrieve newly created record with ID ${insertedId}`);
        }
        return created;
      } catch (error: any) {
        const msg = String(error?.message || '').toLowerCase();
        const errNumber = error?.number;

        if (
          msg.includes('duplicate') ||
          msg.includes('unique') ||
          errNumber === 2627 ||
          errNumber === 2601
        ) {
          throw new An5.An5ClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "mock",
          });
        }

        if (msg.includes('foreign key') || errNumber === 547) {
          throw new An5.An5ClientKnownRequestError("Foreign key constraint failed", {
            code: "P2003",
            clientVersion: "mock",
          });
        }

        if (msg.includes('not found') || errNumber === 404) {
          throw new An5.An5ClientKnownRequestError("Record not found", {
            code: "P2025",
            clientVersion: "mock",
          });
        }

        throw error;
      }
    });
  }

  async update(args: any): Promise<T> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'update', args }, async (params) => {
      const { args: finalArgs } = params;
      const data = { ...finalArgs.data };
      if (modelFields[this.modelName]?.updatedAt) {
        data.updatedAt = new Date();
      }

      // Extract nested writes
      const nestedData: Record<string, any> = {};
      const modelRelations = relationMap[this.modelName] || {};
      for (const key of Object.keys(data)) {
        if (modelRelations[key]) {
          nestedData[key] = data[key];
          delete data[key];
        }
      }

      delete data.id;

      // Handle one-relation connect where we hold the FK
      for (const [key, value] of Object.entries(nestedData)) {
        const rel = modelRelations[key];
        if (rel && rel.relationType === "one" && (value as any).connect) {
          const connectObj = (value as any).connect;
          const targetId = connectObj.id || Object.values(connectObj)[0];
          data[rel.foreignKey] = targetId;
        }
      }

      const sets: string[] = [];
      const p: Record<string, any> = {};

      for (const key of Object.keys(data)) {
        const val = data[key];
        if (val && typeof val === "object" && !(val instanceof Date)) {
          if (val.increment !== undefined) {
            sets.push(`[${key}] = [${key}] + @${key}_inc`);
            p[`${key}_inc`] = val.increment;
            continue;
          } else if (val.decrement !== undefined) {
            sets.push(`[${key}] = [${key}] - @${key}_dec`);
            p[`${key}_dec`] = val.decrement;
            continue;
          } else if (val.set !== undefined) {
            sets.push(`[${key}] = @${key}_set`);
            p[`${key}_set`] = val.set;
            continue;
          }
        }

        sets.push(`[${key}] = @${key}`);
        p[key] = val;
      }

      const whereParams: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, finalArgs.where, whereParams, "w_");
      Object.assign(p, whereParams);

      const sqlText = `UPDATE ${this.tableName} SET ${sets.join(", ")} WHERE ${whereSql}`;
      await this.executor(sqlText, p);

      // Get parent ID for nested writes
      const existing = await this.findUnique({ where: finalArgs.where });
      if (!existing) throw new Error("Record not found to update");
      const parentId = (existing as any).id;

      // Process nested writes
      await this.handleNestedWrites(nestedData, parentId);

      const updated = await this.findUnique({ where: finalArgs.where, include: finalArgs.include });
      if (!updated) {
        throw new Error(`Failed to retrieve updated record`);
      }
      return updated;
    });
  }

  async updateMany(args: any): Promise<{ count: number }> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'updateMany', args }, async (params) => {
      const { args: finalArgs } = params;
      const data = { ...finalArgs.data };
      if (modelFields[this.modelName]?.updatedAt) {
        data.updatedAt = new Date();
      }
      delete data.id;

      const sets: string[] = [];
      const p: Record<string, any> = {};

      for (const key of Object.keys(data)) {
        const val = data[key];
        if (relationMap[this.modelName]?.[key]) continue;

        if (val && typeof val === "object" && !(val instanceof Date)) {
          if (val.increment !== undefined) {
            sets.push(`[${key}] = [${key}] + @${key}_inc`);
            p[`${key}_inc`] = val.increment;
            continue;
          } else if (val.decrement !== undefined) {
            sets.push(`[${key}] = [${key}] - @${key}_dec`);
            p[`${key}_dec`] = val.decrement;
            continue;
          } else if (val.set !== undefined) {
            sets.push(`[${key}] = @${key}_set`);
            p[`${key}_set`] = val.set;
            continue;
          }
        }

        sets.push(`[${key}] = @${key}`);
        p[key] = val;
      }

      const whereParams: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, finalArgs.where, whereParams, "w_");
      Object.assign(p, whereParams);

      const sqlText = `UPDATE ${this.tableName} SET ${sets.join(", ")} ${whereSql ? `WHERE ${whereSql}` : ""}`;
      const pool = await (await getAdapter()).getPool();
      const request = new sql.Request(pool);
      for (const [key, value] of Object.entries(p)) {
        request.input(key, value);
      }
      const result = await request.query(sqlText);
      return { count: result.rowsAffected?.[0] || 0 };
    });
  }

  async delete(args: any): Promise<T> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'delete', args }, async (params) => {
      const { args: finalArgs } = params;
      const existing = await this.findUnique({ where: finalArgs.where });
      if (!existing) throw new Error("Record not found to delete");

      const p: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, finalArgs.where, p);
      const sqlText = `DELETE FROM ${this.tableName} WHERE ${whereSql}`;
      await this.executor(sqlText, p);

      return existing;
    });
  }

  async deleteMany(args?: any): Promise<{ count: number }> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'deleteMany', args }, async (params) => {
      const { args: finalArgs } = params;
      const p: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, finalArgs?.where, p);
      const sqlText = `DELETE FROM ${this.tableName} ${whereSql ? `WHERE ${whereSql}` : ""}`;

      const pool = await (await getAdapter()).getPool();
      const request = new sql.Request(pool);
      for (const [key, value] of Object.entries(p)) {
        request.input(key, value);
      }
      const result = await request.query(sqlText);
      return { count: result.rowsAffected?.[0] || 0 };
    });
  }

  async vectorSearch(args: {
    vector: number[];
    take?: number;
    where?: any;
    include?: any;
    vectorField?: string;
    distanceMetric?: 'cosine' | 'euclidean' | 'dot';
    vectorElementType?: 'float32' | 'float16' | 'uint8';
  }): Promise<(T & { distance: number })[]> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'vectorSearch', args }, async (params) => {
      const { args: finalArgs } = params;
      const field = finalArgs.vectorField || "embedding";
      const metric = finalArgs.distanceMetric || "cosine";
      const elementType = finalArgs.vectorElementType || "float32";
      const take = finalArgs.take || 10;
      const dim = finalArgs.vector.length;
      const vectorJson = JSON.stringify(finalArgs.vector);

      try {
        if (dim > 1998) {
          throw new Error("Vector dimension exceeds SQL Server limit of 1998");
        }
        let sqlText = `SELECT TOP (${take}) *, `;
        sqlText += `VECTOR_DISTANCE('${metric}', CAST([${field}] AS VECTOR(${dim}, ${elementType})), CAST(@query_vector AS VECTOR(${dim}, ${elementType}))) AS distance `;
        sqlText += `FROM ${this.tableName} WITH (NOLOCK) `;

        const p: Record<string, any> = {
          query_vector: vectorJson
        };

        const whereClauses: string[] = [];
        whereClauses.push(`[${field}] IS NOT NULL`);

        const whereSql = parseWhere(this.modelName, finalArgs.where, p, "v_");
        if (whereSql) {
          whereClauses.push(whereSql);
        }

        sqlText += `WHERE ${whereClauses.join(" AND ")} `;
        sqlText += `ORDER BY distance ASC`;

        const rows = await this.executor(sqlText, p);
        if (finalArgs.include) {
          await resolveIncludes(this.modelName, rows, finalArgs.include, this.executor);
        }
        return rows as (T & { distance: number })[];
      } catch (err: any) {
        const msg = String(err.message || "").toLowerCase();
        
        // Handle specific float16 to float32 conversion error by retrying with float16
        if (msg.includes("float16") && msg.includes("float32") && msg.includes("conversion") && !finalArgs.vectorElementType) {
          logger.info(`Detected float16 vector storage. Retrying vectorSearch with float16 element type.`);
          return (this as any).vectorSearch({ ...finalArgs, vectorElementType: 'float16' });
        }

        const isUnsupported = msg.includes("vector_distance") ||
          msg.includes("type vector") ||
          msg.includes("limit of 1998") ||
          err?.number === 195;

        if (!isUnsupported) {
          throw err;
        }

        logger.warn(`Native VECTOR_DISTANCE not supported by SQL Server instance. Falling back to in-memory similarity search.`);

        let fallbackSql = `SELECT * FROM ${this.tableName} WITH (NOLOCK) `;
        const fallbackParams: Record<string, any> = {};
        const fallbackWhereClauses: string[] = [];
        fallbackWhereClauses.push(`[${field}] IS NOT NULL`);

        const fallbackWhereSql = parseWhere(this.modelName, finalArgs.where, fallbackParams, "vf_");
        if (fallbackWhereSql) {
          fallbackWhereClauses.push(fallbackWhereSql);
        }
        fallbackSql += `WHERE ${fallbackWhereClauses.join(" AND ")}`;

        const rows = await this.executor(fallbackSql, fallbackParams);

        const scored = rows.map((row: any) => {
          let distance = 1.0;
          try {
            const rowVector = typeof row[field] === "string"
              ? (JSON.parse(row[field]) as number[])
              : (row[field] as number[]);

            if (Array.isArray(rowVector)) {
              let dotProduct = 0;
              let normA = 0;
              let normB = 0;
              for (let i = 0; i < finalArgs.vector.length; i++) {
                const valA = finalArgs.vector[i] || 0;
                const valB = rowVector[i] || 0;
                dotProduct += valA * valB;
                normA += valA * valA;
                normB += valB * valB;
              }
              const similarity = (normA === 0 || normB === 0) ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
              distance = 1.0 - similarity;
            }
          } catch { /* skip */ }
          return {
            ...row,
            distance
          };
        });

        const results = scored
          .sort((a, b) => a.distance - b.distance)
          .slice(0, take);

        if (finalArgs.include && results.length > 0) {
          await resolveIncludes(this.modelName, results, finalArgs.include, this.executor);
        }

        return results;
      }
    });
  }

  async createMany(args: { data: any[]; skipDuplicates?: boolean }): Promise<{ count: number }> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'createMany', args }, async (params) => {
      const { args: finalArgs } = params;
      if (!finalArgs.data || finalArgs.data.length === 0) return { count: 0 };

      try {
        const pool = await (await getAdapter()).getPool();
        const table = new sql.Table(this.tableName);

        const fields = modelFields[this.modelName] || {};
        const fieldNames = Object.keys(fields);

        for (const col of fieldNames) {
          const fieldDef = fields[col];
          const rawType = fieldDef?.ts || 'string';
          const sqlType = fieldDef?.sql || 'NVARCHAR(MAX)';
          const isNullable = rawType.endsWith('?');
          const tsType = isNullable ? rawType.slice(0, -1) : rawType;

          // Map SQL Server type to mssql package type
          const sqlBase = sqlType.toUpperCase().split('(')[0];
          if (sqlBase === 'INT' || sqlBase === 'SMALLINT' || sqlBase === 'TINYINT') {
            table.columns.add(col, sql.Int, { nullable: isNullable });
          } else if (sqlBase === 'BIGINT') {
            table.columns.add(col, sql.BigInt, { nullable: isNullable });
          } else if (sqlBase === 'FLOAT' || sqlBase === 'REAL' || sqlBase === 'DECIMAL' || sqlBase === 'NUMERIC' || sqlBase === 'MONEY' || sqlBase === 'SMALLMONEY') {
            table.columns.add(col, sql.Float, { nullable: isNullable });
          } else if (sqlBase === 'BIT') {
            table.columns.add(col, sql.Bit, { nullable: isNullable });
          } else if (sqlBase === 'DATETIME' || sqlBase === 'DATETIME2' || sqlBase === 'SMALLDATETIME' || sqlBase === 'DATE' || sqlBase === 'TIME') {
            table.columns.add(col, sql.DateTime, { nullable: isNullable });
          } else if (sqlBase === 'UNIQUEIDENTIFIER') {
            table.columns.add(col, sql.UniqueIdentifier, { nullable: isNullable });
          } else {
            table.columns.add(col, sql.NVarChar(sql.MAX), { nullable: isNullable });
          }
        }

        const now = new Date();
        for (const item of finalArgs.data) {
          const rowData = { ...item };
          if (!rowData.id && fields.id?.ts === "string") rowData.id = randomUUID();
          if (!rowData.createdAt && fields.createdAt) rowData.createdAt = now;
          if (!rowData.updatedAt && fields.updatedAt) rowData.updatedAt = now;

          const rowValues = fieldNames.map(col => {
            const v = rowData[col];
            if (v === undefined) return null;
            return v;
          });
          table.rows.add(...rowValues);
        }

        const request = new sql.Request(pool);
        await request.bulk(table);
        return { count: finalArgs.data.length };
      } catch (err: any) {
        logger.warn(`Bulk insert failed, falling back to sequential inserts: ${err.message}`);
        let count = 0;
        for (const item of finalArgs.data) {
          try {
            await this.create({ data: item });
            count++;
          } catch (innerErr) {
            if (finalArgs.skipDuplicates) continue;
            throw innerErr;
          }
        }
        return { count };
      }
    });
  }

  async aggregate(args: any): Promise<any> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'aggregate', args }, async (params) => {
      const { args: finalArgs } = params;
      const selects: string[] = [];
      const resultObj: any = {};

      if (finalArgs._sum) {
        resultObj._sum = {};
        for (const key of Object.keys(finalArgs._sum)) {
          selects.push(`SUM(${key}) as sum_${key}`);
        }
      }
      if (finalArgs._avg) {
        resultObj._avg = {};
        for (const key of Object.keys(finalArgs._avg)) {
          selects.push(`AVG(${key}) as avg_${key}`);
        }
      }
      if (finalArgs._min) {
        resultObj._min = {};
        for (const key of Object.keys(finalArgs._min)) {
          selects.push(`MIN(${key}) as min_${key}`);
        }
      }
      if (finalArgs._max) {
        resultObj._max = {};
        for (const key of Object.keys(finalArgs._max)) {
          selects.push(`MAX(${key}) as max_${key}`);
        }
      }
      if (finalArgs._count) {
        resultObj._count = {};
        if (finalArgs._count === true || finalArgs._count._all) {
          selects.push(`COUNT(*) as count_all`);
        } else {
          for (const key of Object.keys(finalArgs._count)) {
            selects.push(`COUNT(${key}) as count_${key}`);
          }
        }
      }

      if (selects.length === 0) {
        throw new Error("Aggregate requires at least one aggregator field");
      }

      let sqlText = `SELECT ${selects.join(", ")} FROM ${this.tableName} WITH (NOLOCK)`;
      const p: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, finalArgs?.where, p);
      if (whereSql) {
        sqlText += ` WHERE ${whereSql}`;
      }

      const rows = await this.executor(sqlText, p);
      const row = rows[0] || {};

      if (finalArgs._sum) {
        for (const key of Object.keys(finalArgs._sum)) {
          resultObj._sum[key] = row[`sum_${key}`] !== undefined ? row[`sum_${key}`] : null;
        }
      }
      if (finalArgs._avg) {
        for (const key of Object.keys(finalArgs._avg)) {
          resultObj._avg[key] = row[`avg_${key}`] !== undefined ? row[`avg_${key}`] : null;
        }
      }
      if (finalArgs._min) {
        for (const key of Object.keys(finalArgs._min)) {
          resultObj._min[key] = row[`min_${key}`] !== undefined ? row[`min_${key}`] : null;
        }
      }
      if (finalArgs._max) {
        for (const key of Object.keys(finalArgs._max)) {
          resultObj._max[key] = row[`max_${key}`] !== undefined ? row[`max_${key}`] : null;
        }
      }
      if (finalArgs._count) {
        if (finalArgs._count === true || finalArgs._count._all) {
          resultObj._count._all = row[`count_all`] || 0;
        } else {
          for (const key of Object.keys(finalArgs._count)) {
            resultObj._count[key] = row[`count_${key}`] || 0;
          }
        }
      }

      return resultObj;
    });
  }

  async groupBy(args: any): Promise<any[]> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'groupBy', args }, async (params) => {
      const { args: finalArgs } = params;
      const byFields = finalArgs.by || [];
      if (byFields.length === 0) {
        throw new Error("groupBy requires 'by' fields");
      }

      const selects = [...byFields];

      if (finalArgs._count) {
        if (finalArgs._count === true || finalArgs._count._all) {
          selects.push(`COUNT(*) as count_all`);
        } else {
          for (const key of Object.keys(finalArgs._count)) {
            selects.push(`COUNT(${key}) as count_${key}`);
          }
        }
      }
      if (finalArgs._sum) {
        for (const key of Object.keys(finalArgs._sum)) {
          selects.push(`SUM(${key}) as sum_${key}`);
        }
      }
      if (finalArgs._avg) {
        for (const key of Object.keys(finalArgs._avg)) {
          selects.push(`AVG(${key}) as avg_${key}`);
        }
      }
      if (finalArgs._min) {
        for (const key of Object.keys(finalArgs._min)) {
          selects.push(`MIN(${key}) as min_${key}`);
        }
      }
      if (finalArgs._max) {
        for (const key of Object.keys(finalArgs._max)) {
          selects.push(`MAX(${key}) as max_${key}`);
        }
      }

      let sqlText = `SELECT ${selects.join(", ")} FROM ${this.tableName} WITH (NOLOCK)`;
      const p: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, finalArgs?.where, p);
      if (whereSql) {
        sqlText += ` WHERE ${whereSql}`;
      }

      sqlText += ` GROUP BY ${byFields.join(", ")}`;

      const rows = await this.executor(sqlText, p);

      return rows.map((row: any) => {
        const item: any = {};
        byFields.forEach((field: string) => {
          item[field] = row[field];
        });

        if (finalArgs._count) {
          item._count = {};
          if (finalArgs._count === true || finalArgs._count._all) {
            item._count._all = row[`count_all`] || 0;
          } else {
            for (const key of Object.keys(finalArgs._count)) {
              item._count[key] = row[`count_${key}`] || 0;
            }
          }
        }
        if (finalArgs._sum) {
          item._sum = {};
          for (const key of Object.keys(finalArgs._sum)) {
            item._sum[key] = row[`sum_${key}`] !== undefined ? row[`sum_${key}`] : null;
          }
        }
        if (finalArgs._avg) {
          item._avg = {};
          for (const key of Object.keys(finalArgs._avg)) {
            item._avg[key] = row[`avg_${key}`] !== undefined ? row[`avg_${key}`] : null;
          }
        }
        if (finalArgs._min) {
          item._min = {};
          for (const key of Object.keys(finalArgs._min)) {
            item._min[key] = row[`min_${key}`] !== undefined ? row[`min_${key}`] : null;
          }
        }
        if (finalArgs._max) {
          item._max = {};
          for (const key of Object.keys(finalArgs._max)) {
            item._max[key] = row[`max_${key}`] !== undefined ? row[`max_${key}`] : null;
          }
        }

        return item;
      });
    });
  }

  async upsert(args: any): Promise<T> {
    return this.orm._executeMiddleware({ model: this.modelName, action: 'upsert', args }, async (params) => {
      const { args: finalArgs } = params;
      const { where, create: createData, update: updateData, include } = finalArgs;

      // Filter out relation fields from data
      const cleanCreate = { ...createData };
      const cleanUpdate = { ...updateData };
      for (const key of Object.keys(cleanCreate)) {
        if (relationMap[this.modelName]?.[key]) delete cleanCreate[key];
      }
      for (const key of Object.keys(cleanUpdate)) {
        if (relationMap[this.modelName]?.[key]) delete cleanUpdate[key];
      }

      if (!cleanCreate.id && modelFields[this.modelName]?.id?.ts === "string") {
        cleanCreate.id = randomUUID();
      }
      const now = new Date();
      if (!cleanCreate.createdAt && modelFields[this.modelName]?.createdAt) cleanCreate.createdAt = now;
      if (!cleanCreate.updatedAt && modelFields[this.modelName]?.updatedAt) cleanCreate.updatedAt = now;
      if (!cleanUpdate.updatedAt && modelFields[this.modelName]?.updatedAt) cleanUpdate.updatedAt = now;

      const p: Record<string, any> = {};
      const whereSql = parseWhere(this.modelName, where, p, "upw_");

      const allKeys = Array.from(new Set([...Object.keys(cleanCreate), ...Object.keys(cleanUpdate)]));
      for (const k of allKeys) {
        if (cleanCreate[k] !== undefined) p[`c_${k}`] = cleanCreate[k];
        if (cleanUpdate[k] !== undefined) p[`u_${k}`] = cleanUpdate[k];
      }

      const sourceSelect = allKeys.map(k => {
        const val = cleanCreate[k] !== undefined ? `@c_${k}` : (cleanUpdate[k] !== undefined ? `@u_${k}` : "NULL");
        return `${val} as [${k}]`;
      }).join(", ");

      const updateSets = Object.keys(cleanUpdate).map(k => `target.[${k}] = source.[${k}]`).join(", ");
      const insertCols = Object.keys(cleanCreate).map(k => `[${k}]`).join(", ");
      const insertVals = Object.keys(cleanCreate).map(k => `source.[${k}]`).join(", ");

      // Note: This MERGE assumes the 'where' translates to a simple ON clause.
      // For complex 'where', parseWhere might return something not easily usable in ON.
      // We'll try to extract simple equality for ON if possible, or fallback to sequential.

      const onClause = Object.keys(where).map(k => {
        if (typeof where[k] === 'object' && where[k] !== null && !(where[k] instanceof Date)) {
          // Flatten unique object if needed
          const inner = where[k];
          return Object.keys(inner).map(ik => `target.[${ik}] = @upw_${k}_${ik}`).join(" AND ");
        }
        return `target.[${k}] = @upw_${k}`;
      }).join(" AND ");

      const sqlText = `
        MERGE INTO ${this.tableName} WITH (HOLDLOCK) AS target
        USING (SELECT ${sourceSelect}) AS source
        ON (${onClause})
        WHEN MATCHED THEN
          UPDATE SET ${updateSets}
        WHEN NOT MATCHED THEN
          INSERT (${insertCols}) VALUES (${insertVals})
        OUTPUT inserted.*;
      `;

      try {
        const rows = await this.executor(sqlText, p);
        const result = rows[0];
        if (include && result) {
          await resolveIncludes(this.modelName, [result], include, this.executor);
        }
        return result as T;
      } catch (err: any) {
        logger.warn(`Atomic upsert failed, falling back to sequential: ${err.message}`);
        const existing = await this.findUnique({ where: finalArgs.where });
        if (existing) {
          return this.update({ where: finalArgs.where, data: finalArgs.update, include: finalArgs.include });
        } else {
          return this.create({ data: finalArgs.create, include: finalArgs.include });
        }
      }
    });
  }
}

function addNoLockToQuery(sql: string): string {
  // If it's not a SELECT query, don't modify it
  if (!/^\s*SELECT/i.test(sql)) {
    return sql;
  }

  const tableNames = Object.values(modelToTable);

  let modifiedSql = sql;

  for (const table of tableNames) {
    const escapedTable = (table as string).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`\\b(FROM|JOIN)\\s+${escapedTable}\\b`, 'gi');

    modifiedSql = modifiedSql.replace(regex, (match, prefix, offset) => {
      const afterMatch = modifiedSql.slice(offset + match.length).trim();

      // If it's already followed by WITH (NOLOCK) or NOLOCK or similar, keep it.
      if (/^(WITH\s*\(NOLOCK\)|NOLOCK)/i.test(afterMatch)) {
        return match;
      }

      // Check if there is an alias (e.g. "FROM chunks c" or "FROM chunks as c")
      const aliasMatch = afterMatch.match(/^(?:as\s+)?([a-zA-Z0-9_]+)/i);
      if (aliasMatch) {
        const alias = aliasMatch[1];
        const keywords = ["where", "on", "join", "group", "order", "limit", "left", "right", "inner", "and", "or"];
        if (!keywords.includes(alias.toLowerCase())) {
          // It's an alias! Let's check if the alias itself is followed by WITH (NOLOCK)
          const afterAlias = afterMatch.slice(aliasMatch[0].length).trim();
          if (/^(WITH\s*\(NOLOCK\)|NOLOCK)/i.test(afterAlias)) {
            return match; // already has NOLOCK after the alias
          }
        }
      }

      return `${prefix} ${table} WITH (NOLOCK)`;
    });
  }

  return modifiedSql;
}

export interface MiddlewareParams {
  model?: string;
  action: string;
  args: any;
  runInTransaction?: boolean;
}

export type MiddlewareNext = (params: MiddlewareParams) => Promise<any>;
export type Middleware = (params: MiddlewareParams, next: MiddlewareNext) => Promise<any>;

// Proxied AN5 ORM client class
export class An5ORM {
  [key: string]: any;
  private middlewares: Middleware[] = [];

  constructor(private customExecutor?: ExecutorFn) {
    // Add default logging middleware
    this.$use(async (params, next) => {
      const start = Date.now();
      try {
        const result = await next(params);
        const duration = Date.now() - start;
        if (process.env.DEBUG_ORM === "true") {
          logger.info(`ORM [${params.model || 'raw'}.${params.action}] executed in ${duration}ms`);
        }
        return result;
      } catch (err) {
        const duration = Date.now() - start;
        logger.error(`ORM [${params.model || 'raw'}.${params.action}] failed after ${duration}ms`, err);
        throw err;
      }
    });

    return new Proxy(this, {
      get(target, prop: string) {
        if (prop === "$use") {
          return target.$use.bind(target);
        }
        if (prop === "$transaction") {
          return target.$transaction.bind(target);
        }
        if (prop === "$connect") {
          return target.$connect.bind(target);
        }
        if (prop === "$disconnect") {
          return target.$disconnect.bind(target);
        }
        if (prop === "$queryRaw") {
          return target.$queryRaw.bind(target);
        }
        if (prop === "$queryRawUnsafe") {
          return target.$queryRawUnsafe.bind(target);
        }
        if (prop === "$executeRaw") {
          return target.$executeRaw.bind(target);
        }
        if (prop === "$executeRawUnsafe") {
          return target.$executeRawUnsafe.bind(target);
        }
        if (!(prop in target) && typeof prop === "string" && !prop.startsWith("_")) {
          // Resolve modelName in camelCase and map to table name
          const tableName = modelToTable[prop];
          if (tableName) {
            target[prop] = new TableClient(
              prop,
              tableName,
              target.customExecutor || execQuery,
              target // Pass ORM instance for middleware access
            );
          }
        }
        return target[prop];
      }
    });
  }

  $use(middleware: Middleware) {
    this.middlewares.push(middleware);
  }

  async _executeMiddleware(params: MiddlewareParams, finalAction: (params: MiddlewareParams) => Promise<any>): Promise<any> {
    let index = -1;
    const dispatch = async (i: number, currentParams: MiddlewareParams): Promise<any> => {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      let fn: Middleware | undefined = this.middlewares[i];
      if (i === this.middlewares.length) {
        return finalAction(currentParams);
      }
      if (!fn) return;
      return fn(currentParams, (p) => dispatch(i + 1, p));
    };
    return dispatch(0, params);
  }

  async $connect(): Promise<void> { }
  async $disconnect(): Promise<void> {
    if (adapter) {
      await adapter.$disconnect();
      adapter = null;
    }
  }

  async $queryRaw(queryParts: any, ...values: any[]): Promise<any[]> {
    const executor = this.customExecutor || execQuery;
    let queryText = "";
    const params: Record<string, any> = {};

    if (Array.isArray(queryParts) && (queryParts as any).raw !== undefined) {
      const strings = queryParts as unknown as TemplateStringsArray;
      for (let i = 0; i < strings.length; i++) {
        queryText += strings[i];
        if (i < values.length) {
          const paramName = `p_${i}`;
          queryText += `@${paramName}`;
          params[paramName] = values[i];
        }
      }
    } else if (typeof queryParts === "string") {
      queryText = queryParts;
      if (values && values.length > 0) {
        values.forEach((val, idx) => {
          const paramName = `p_${idx}`;
          params[paramName] = val;
        });
      }
    } else {
      throw new Error("Invalid query format for $queryRaw");
    }

    queryText = addNoLockToQuery(queryText);
    return executor(queryText, params);
  }

  async $queryRawUnsafe<R = any>(queryText: string, ...values: any[]): Promise<R> {
    const executor = this.customExecutor || execQuery;
    const params: Record<string, any> = {};
    if (values && values.length > 0) {
      values.forEach((val, idx) => {
        const paramName = `p_${idx}`;
        params[paramName] = val;
      });
    }

    const modifiedQueryText = addNoLockToQuery(queryText);
    const result = await executor(modifiedQueryText, params);
    return result as unknown as R;
  }

  async $executeRaw(queryParts: any, ...values: any[]): Promise<number> {
    const executor = this.customExecutor || execQuery;
    let queryText = "";
    const params: Record<string, any> = {};

    if (Array.isArray(queryParts) && (queryParts as any).raw !== undefined) {
      const strings = queryParts as unknown as TemplateStringsArray;
      for (let i = 0; i < strings.length; i++) {
        queryText += strings[i];
        if (i < values.length) {
          const paramName = `p_${i}`;
          queryText += `@${paramName}`;
          params[paramName] = values[i];
        }
      }
    } else if (typeof queryParts === "string") {
      queryText = queryParts;
      if (values && values.length > 0) {
        values.forEach((val, idx) => {
          const paramName = `p_${idx}`;
          params[paramName] = val;
        });
      }
    } else {
      throw new Error("Invalid query format for $executeRaw");
    }

    queryText = addNoLockToQuery(queryText);
    const result = (await executor(queryText, params)) as any;
    return result.rowsAffected?.[0] || 0;
  }

  async $executeRawUnsafe(queryText: string, ...values: any[]): Promise<number> {
    const executor = this.customExecutor || execQuery;
    const params: Record<string, any> = {};
    if (values && values.length > 0) {
      values.forEach((val, idx) => {
        const paramName = `p_${idx}`;
        params[paramName] = val;
      });
    }

    const modifiedQueryText = addNoLockToQuery(queryText);
    const result = (await executor(modifiedQueryText, params)) as any;
    return result.rowsAffected?.[0] || 0;
  }

  async $transaction<R>(
    fn: ((tx: any) => Promise<R>) | Promise<any>[],
    options?: { timeout?: number }
  ): Promise<any> {
    if (Array.isArray(fn)) {
      return Promise.all(fn);
    }

    const pool = await getDbPool();
    const transaction = new sql.Transaction(pool);

    await transaction.begin();
    logger.info("Database Transaction Initiated");

    const txExecutor: ExecutorFn = async (queryText: string, params?: Record<string, any>) => {
      const request = new sql.Request(transaction);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          request.input(key, value);
        }
      }
      const result = await request.query(queryText);
      const recordset = (result.recordset || []) as any;
      recordset.rowsAffected = result.rowsAffected;
      return recordset;
    };

    const txClient = new An5ORM(txExecutor);

    try {
      const result = await fn(txClient);
      await transaction.commit();
      logger.info("Database Transaction Committed Successfully");
      return result;
    } catch (err) {
      try {
        await transaction.rollback();
        logger.warn("Database Transaction Rolled Back");
      } catch (rollbackErr) {
        logger.error("Failed to rollback database transaction", rollbackErr);
      }
      throw err;
    }
  }
}

export const an5Orm = new An5ORM();
export default an5Orm;
