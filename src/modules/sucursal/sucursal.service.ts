import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Sucursal } from '../entities/sucursal.entity';

@Injectable()
export class SucursalService extends CrudService<Sucursal> {
  constructor(
    @InjectRepository(Sucursal) repository: Repository<Sucursal>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(repository);
  }

  async findAllScoped(page = 1, limit = 10, search?: string, sucursalId?: string | null) {
    const safePage = Number.isFinite(+page) && +page > 0 ? +page : 1;
    const safeLimit =
      Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, 100) : 10;
    const normalizedSearch = String(search ?? '').trim();

    const qb = this.repository
      .createQueryBuilder('sucursal')
      .where('sucursal.is_deleted = false');

    if (sucursalId) {
      qb.andWhere('sucursal.id = :sucursalId', { sucursalId });
    }

    if (normalizedSearch) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('sucursal.codigo ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('sucursal.nombre ILIKE :search', {
              search: `%${normalizedSearch}%`,
            });
        }),
      );
    }

    const [data, total] = await qb
      .orderBy('sucursal.codigo', 'ASC')
      .addOrderBy('sucursal.nombre', 'ASC')
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit)
      .getManyAndCount();

    return {
      data,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  private quoteSqlIdentifier(value: string) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  private async tableExists(
    manager: EntityManager,
    schema: string,
    table: string,
  ) {
    const rows = await manager.query(
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
        LIMIT 1
      `,
      [schema, table],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  private async tableColumnExists(
    manager: EntityManager,
    schema: string,
    table: string,
    column: string,
  ) {
    const rows = await manager.query(
      `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
          AND column_name = $3
        LIMIT 1
      `,
      [schema, table, column],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  private async hardDeleteTableIfExists(
    manager: EntityManager,
    schema: string,
    table: string,
  ) {
    if (!(await this.tableExists(manager, schema, table))) return 0;
    const qualifiedTable = `${this.quoteSqlIdentifier(
      schema,
    )}.${this.quoteSqlIdentifier(table)}`;
    const rows = await manager.query(
      `
        DELETE FROM ${qualifiedTable}
        RETURNING 1
      `,
    );
    return Array.isArray(rows) ? rows.length : 0;
  }

  private async nullifyColumnIfExists(
    manager: EntityManager,
    schema: string,
    table: string,
    column: string,
  ) {
    if (!(await this.tableColumnExists(manager, schema, table, column))) {
      return 0;
    }
    const qualifiedTable = `${this.quoteSqlIdentifier(
      schema,
    )}.${this.quoteSqlIdentifier(table)}`;
    const quotedColumn = this.quoteSqlIdentifier(column);
    const rows = await manager.query(
      `
        UPDATE ${qualifiedTable}
        SET ${quotedColumn} = NULL
        WHERE ${quotedColumn} IS NOT NULL
        RETURNING 1
      `,
    );
    return Array.isArray(rows) ? rows.length : 0;
  }

  private async stripJsonbKeysIfExists(
    manager: EntityManager,
    schema: string,
    table: string,
    column: string,
    keys: string[],
  ) {
    const normalizedKeys = keys
      .map((key) => String(key || '').trim())
      .filter(Boolean);
    if (!normalizedKeys.length) return 0;
    if (!(await this.tableColumnExists(manager, schema, table, column))) {
      return 0;
    }

    const qualifiedTable = `${this.quoteSqlIdentifier(
      schema,
    )}.${this.quoteSqlIdentifier(table)}`;
    const quotedColumn = this.quoteSqlIdentifier(column);
    const placeholders = normalizedKeys.map((_, index) => `$${index + 1}`);
    const strippedExpression = normalizedKeys.reduce(
      (expression, _, index) => `${expression} - $${index + 1}`,
      quotedColumn,
    );
    const rows = await manager.query(
      `
        UPDATE ${qualifiedTable}
        SET ${quotedColumn} = ${strippedExpression}
        WHERE ${quotedColumn} IS NOT NULL
          AND jsonb_typeof(${quotedColumn}) = 'object'
          AND ${quotedColumn} ?| ARRAY[${placeholders.join(', ')}]::text[]
        RETURNING 1
      `,
      normalizedKeys,
    );
    return Array.isArray(rows) ? rows.length : 0;
  }

  async purgeAll(roleName?: string) {
    this.assertCanPurge(roleName);

    const details = await this.dataSource.transaction(async (manager) => {
      const totals: Record<string, number> = {};
      const delTable = async (key: string, schema: string, table: string) => {
        const affected = await this.hardDeleteTableIfExists(
          manager,
          schema,
          table,
        );
        totals[key] = (totals[key] || 0) + affected;
      };
      const nullify = async (schema: string, table: string, column: string) => {
        await this.nullifyColumnIfExists(manager, schema, table, column);
      };
      const stripJson = async (
        schema: string,
        table: string,
        column: string,
        keys: string[],
      ) => {
        await this.stripJsonbKeysIfExists(
          manager,
          schema,
          table,
          column,
          keys,
        );
      };

      await delTable('usuarios_sucursales', 'kpi_security', 'tb_user_sucursal');
      await nullify('kpi_maintenance', 'tb_location', 'sucursal_id');
      await nullify('kpi_maintenance', 'tb_programacion_mensual', 'sucursal_id');
      await nullify('kpi_maintenance', 'tb_cronograma_semanal', 'sucursal_id');
      await nullify(
        'kpi_maintenance',
        'tb_reporte_operacion_diaria',
        'sucursal_id',
      );
      await stripJson(
        'kpi_maintenance',
        'tb_programacion_plan',
        'payload_json',
        ['sucursal_id', 'sucursal_codigo', 'sucursal_nombre'],
      );
      await stripJson(
        'kpi_maintenance',
        'tb_programacion_mensual',
        'payload_json',
        ['sucursal_id', 'sucursal_codigo', 'sucursal_nombre'],
      );
      await stripJson(
        'kpi_maintenance',
        'tb_cronograma_semanal',
        'payload_json',
        ['sucursal_id', 'sucursal_codigo', 'sucursal_nombre'],
      );
      await stripJson(
        'kpi_maintenance',
        'tb_reporte_operacion_diaria',
        'payload_json',
        ['sucursal_id', 'sucursal_codigo', 'sucursal_nombre'],
      );

      const result = await manager
        .createQueryBuilder()
        .delete()
        .from(Sucursal)
        .execute();
      totals.sucursales = Number(result.affected || 0);
      return totals;
    });

    const affected = Number(details.sucursales || 0);
    return {
      message: `Eliminacion real masiva ejecutada correctamente (${affected} registros).`,
      affected,
      details,
    };
  }
}
