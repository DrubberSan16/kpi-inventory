import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import * as XLSX from 'xlsx';
import { Kardex } from '../entities/kardex.entity';
import { StockBodega } from '../entities/stock-bodega.entity';
import { MovimientoInventario } from '../entities/movimiento-inventario.entity';
import { MovimientoInventarioDet } from '../entities/movimiento-inventario-det.entity';
import { Producto } from '../entities/producto.entity';
import { Bodega } from '../entities/bodega.entity';
import { Sucursal } from '../entities/sucursal.entity';
import { Linea } from '../entities/linea.entity';
import { Categoria } from '../entities/categoria.entity';
import { Marca } from '../entities/marca.entity';
import { UnidadMedida } from '../entities/unidad-medida.entity';

type MovementType = 'INGRESO' | 'SALIDA';

type ManualMovementPayload = {
  tipo_movimiento?: string;
  bodega_id?: string;
  producto_id?: string;
  cantidad?: string | number;
  observacion?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
};

type ImportInventorySummary = {
  procesados: number;
  omitidos: number;
  creados: number;
  actualizados: number;
  ingresos: number;
  salidas: number;
  errores: string[];
};

type InventoryImportProgress = {
  currentIndex: number;
  totalRows: number;
  currentStep: string;
};

type InventoryImportResult = ImportInventorySummary & {
  hoja: string;
  total_filas: number;
};

type InventoryImportJobStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

type InventoryImportJobState = {
  id: string;
  status: InventoryImportJobStatus;
  progress: number;
  source_file_name: string | null;
  stored_file_name: string | null;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  current_step: string | null;
  current_index: number;
  total_rows: number;
  summary: InventoryImportResult | null;
  error_message: string | null;
};

@Injectable()
export class KardexService extends CrudService<Kardex> {
  private readonly logger = new Logger(KardexService.name);
  private readonly importJobs = new Map<string, InventoryImportJobState>();
  private readonly importRoot: string;

  constructor(
    @InjectRepository(Kardex)
    repository: Repository<Kardex>,
    @InjectRepository(StockBodega)
    private readonly stockRepo: Repository<StockBodega>,
    @InjectRepository(MovimientoInventario)
    private readonly movimientoRepo: Repository<MovimientoInventario>,
    @InjectRepository(MovimientoInventarioDet)
    private readonly movimientoDetRepo: Repository<MovimientoInventarioDet>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(Bodega)
    private readonly bodegaRepo: Repository<Bodega>,
    @InjectRepository(Sucursal)
    private readonly sucursalRepo: Repository<Sucursal>,
    @InjectRepository(Linea)
    private readonly lineaRepo: Repository<Linea>,
    @InjectRepository(Categoria)
    private readonly categoriaRepo: Repository<Categoria>,
    @InjectRepository(UnidadMedida)
    private readonly unidadRepo: Repository<UnidadMedida>,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(repository);
    const configuredImportRoot = String(
      this.configService.get('INVENTORY_IMPORT_DIR') || '',
    ).trim();
    this.importRoot =
      configuredImportRoot || join(process.cwd(), 'storage', 'inventory-imports');
  }

  async findAllPaginated(
    page = 1,
    limit = 10,
    search?: string,
    sucursalId?: string | null,
  ) {
    const safePage = Number.isFinite(+page) && +page > 0 ? +page : 1;
    const safeLimit =
      Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, 100) : 10;
    const normalizedSearch = String(search ?? '').trim();

    const qb = this.repository
      .createQueryBuilder('kardex')
      .leftJoin(
        Bodega,
        'bodega',
        'bodega.id = kardex.bodega_id AND bodega.is_deleted = false',
      )
      .leftJoin(
        Producto,
        'producto',
        'producto.id = kardex.producto_id AND producto.is_deleted = false',
      )
      .where('kardex.is_deleted = false');

    if (sucursalId) {
      qb.andWhere('bodega.sucursal_id = :sucursalId', { sucursalId });
    }

    if (normalizedSearch) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('producto.nombre ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('producto.codigo ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('bodega.nombre ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('bodega.codigo ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('kardex.tipo_movimiento ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(kardex.observacion, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            });
        }),
      );
    }

    const [data, total] = await qb
      .orderBy('kardex.fecha', 'DESC')
      .addOrderBy('kardex.created_at', 'DESC')
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

  async registerManualMovement(payload: ManualMovementPayload) {
    const tipo = this.normalizeMovementType(payload.tipo_movimiento);
    const bodegaId = this.toText(payload.bodega_id);
    const productoId = this.toText(payload.producto_id);
    const cantidad = this.toNumber(payload.cantidad, -1);
    const userName =
      this.toText(payload.updated_by) || this.toText(payload.created_by) || 'SYSTEM';

    if (!tipo) {
      throw new BadRequestException(
        'El tipo de movimiento debe ser INGRESO o SALIDA.',
      );
    }
    if (!bodegaId) {
      throw new BadRequestException('La bodega es obligatoria.');
    }
    if (!productoId) {
      throw new BadRequestException('El material es obligatorio.');
    }
    if (!(cantidad > 0)) {
      throw new BadRequestException('La cantidad debe ser mayor a cero.');
    }
    const changedStockIds = new Set<string>();

    const result = await this.dataSource.transaction(async (manager) => {
      const bodega = await manager.findOne(Bodega, {
        where: { id: bodegaId, is_deleted: false },
      });
      if (!bodega) {
        throw new NotFoundException('La bodega seleccionada no existe.');
      }

      const producto = await manager.findOne(Producto, {
        where: { id: productoId, is_deleted: false },
      });
      if (!producto) {
        throw new NotFoundException('El material seleccionado no existe.');
      }

      const stockRow = await this.getOrCreateStockRow(manager, {
        bodegaId,
        productoId,
        costoPromedio: this.resolveProductoUnitCost(producto),
        userName,
      });
      const costoUnitario = this.resolveProductoUnitCost(producto, stockRow);

      const stockAnterior = this.toNumber(stockRow.stock_actual, 0);
      const delta = tipo === 'INGRESO' ? cantidad : -cantidad;
      const stockNuevo = stockAnterior + delta;

      if (stockNuevo < 0) {
        throw new BadRequestException(
          'No existe stock suficiente para realizar la salida.',
        );
      }

      stockRow.stock_actual = this.toFixedText(stockNuevo, 6);
      stockRow.costo_promedio_bodega = this.toFixedText(costoUnitario, 4);
      stockRow.updated_by = userName;
      await manager.save(StockBodega, stockRow);
      changedStockIds.add(stockRow.id);

      const artifacts = await this.createMovementArtifacts(manager, {
        tipo,
        bodegaId,
        productoId,
        cantidad,
        costoUnitario,
        stockNuevo,
        observacion:
          this.toText(payload.observacion) || `${tipo} manual de material`,
        userName,
      });

      return {
        stock: stockRow,
        ...artifacts,
      };
    });

    await this.notifyMaintenanceRecalculationForStocks(changedStockIds, 'manual');
    return result;
  }

  async importInventoryWorkbook(
    buffer: Buffer,
    options?: {
      requestedBy?: string | null;
      originalName?: string | null;
      mimeType?: string | null;
      onProgress?: (progress: InventoryImportProgress) => Promise<void> | void;
    },
  ) {
    const workbook = this.readInventoryWorkbook(buffer, options);
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new BadRequestException(
        'El archivo no contiene hojas válidas para importar.',
      );
    }

    const sheet = workbook.Sheets[firstSheetName];
    if (!sheet) {
      throw new BadRequestException('No se pudo leer la hoja principal del Excel.');
    }

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
    });

    if (!rows.length) {
      throw new BadRequestException('El archivo no contiene filas de datos.');
    }

    const summary: ImportInventorySummary = {
      procesados: 0,
      omitidos: 0,
      creados: 0,
      actualizados: 0,
      ingresos: 0,
      salidas: 0,
      errores: [],
    };

    const userName = this.toText(options?.requestedBy) || 'SYSTEM';
    const changedStockIds = new Set<string>();

    await options?.onProgress?.({
      currentIndex: 0,
      totalRows: rows.length,
      currentStep: `Preparando ${rows.length} fila(s) para importar.`,
    });

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];

      try {
        const processed = await this.importInventoryRowNormalized(
          row,
          userName,
          summary,
          changedStockIds,
        );
        if (processed) summary.procesados += 1;
        else summary.omitidos += 1;
      } catch (error: any) {
        summary.errores.push(
          `Fila ${index + 2}: ${error?.message ?? 'No se pudo importar.'}`,
        );
      }

      await options?.onProgress?.({
        currentIndex: index + 1,
        totalRows: rows.length,
        currentStep: `Procesando fila ${index + 2} de ${rows.length + 1}.`,
      });
    }

    await this.notifyMaintenanceRecalculationForStocks(changedStockIds, 'import');

    return {
      ...summary,
      hoja: firstSheetName,
      total_filas: rows.length,
    };
  }

  async startInventoryImport(
    file: {
      buffer?: Buffer;
      originalname?: string | null;
      mimetype?: string | null;
    },
    options?: {
      requestedBy?: string | null;
    },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        'Debes adjuntar un archivo CSV o Excel válido.',
      );
    }

    const jobId = randomUUID();
    const sourceFileName =
      this.toText(file.originalname) || `inventario-${jobId}.csv`;
    const storedFileName = sourceFileName.replace(/[\\/:*?"<>|]+/g, '_');
    const targetDir = join(this.importRoot, jobId);
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, storedFileName), file.buffer);

    const job: InventoryImportJobState = {
      id: jobId,
      status: 'QUEUED',
      progress: 0,
      source_file_name: sourceFileName,
      stored_file_name: storedFileName,
      requested_by: this.toText(options?.requestedBy) || 'SYSTEM',
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      current_step: 'Archivo recibido. Esperando procesamiento.',
      current_index: 0,
      total_rows: 0,
      summary: null,
      error_message: null,
    };

    this.importJobs.set(jobId, job);
    void this.notifyMaintenanceImportLifecycle('started', jobId);

    setImmediate(() => {
      void this.runInventoryImportJob(jobId, file.buffer!, {
        requestedBy: options?.requestedBy,
        originalName: file.originalname,
        mimeType: file.mimetype,
      });
    });

    return job;
  }

  getInventoryImportJob(jobId: string) {
    const job = this.importJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('La carga de inventario solicitada no existe.');
    }
    return job;
  }

  getActiveInventoryImportSummary() {
    const activeJobs = [...this.importJobs.values()]
      .filter((job) => ['QUEUED', 'PROCESSING'].includes(job.status))
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );

    return {
      active: activeJobs.length > 0,
      total_jobs: activeJobs.length,
      jobs: activeJobs.map((job) => ({
        id: job.id,
        status: job.status,
        progress: job.progress,
        source_file_name: job.source_file_name,
        requested_by: job.requested_by,
        created_at: job.created_at,
        started_at: job.started_at,
        current_step: job.current_step,
        current_index: job.current_index,
        total_rows: job.total_rows,
      })),
    };
  }

  getImportTemplateBuffer() {
    const headers = [
      'Cod. Sucursal',
      'Sucursal',
      'Cod. Bodega',
      'Bodega',
      'Cod. Línea',
      'Linea',
      'Tipo',
      'Categoria',
      'Reg. Sanitario',
      'Marca',
      'Cod. Item',
      'Item',
      'Sección',
      'Nivel',
      'Último costo',
      'Costo promedio',
      'Precio',
      '% UTILIDAD',
      '% TC',
      'VALOR TC',
      'Tipo de unidad',
      'Por contenedores',
      'Stock',
      'Stock min. bodega',
      'Stock max. bodega',
      'Stock contenedores',
      'Stock minimo',
    ];

    const sample = {
      'Cod. Sucursal': 'SUC-001',
      Sucursal: 'Matriz',
      'Cod. Bodega': 'BOD-001',
      Bodega: 'Bodega Principal',
      'Cod. Línea': 'SUM',
      Linea: 'MANTENIMIENTO',
      Tipo: 'Mercadería',
      Categoria: 'HERRAMIENTAS',
      'Reg. Sanitario': '',
      Marca: 'GULF',
      'Cod. Item': '175',
      Item: 'PROBADOR DE TIERRA DIGITAL',
      'Sección': 'MATERIAL VARIOS',
      Nivel: '',
      'Último costo': 25.5,
      'Costo promedio': 25.5,
      Precio: 35,
      '% UTILIDAD': 37.25,
      '% TC': 0,
      'VALOR TC': 0,
      'Tipo de unidad': 'UNIDAD',
      'Por contenedores': 'N',
      Stock: 80,
      'Stock min. bodega': 5,
      'Stock max. bodega': 10000,
      'Stock contenedores': 0,
      'Stock minimo': 5,
      Costo: 2040,
    };

    const worksheet = XLSX.utils.json_to_sheet([sample], {
      header: headers,
      skipHeader: false,
    });

    worksheet['!cols'] = headers.map((header) => ({
      wch: Math.max(header.length + 2, 18),
    }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'INVENTARIO');

    return XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
  }

  private normalizeMovementType(value: unknown): MovementType | null {
    const raw = this.toText(value).toUpperCase();
    if (raw === 'INGRESO') return 'INGRESO';
    if (raw === 'SALIDA') return 'SALIDA';
    return null;
  }

  private toNumber(value: unknown, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    const normalizedText = this.toText(value).replace(/\s+/g, '');
    if (!normalizedText) return fallback;

    const hasComma = normalizedText.includes(',');
    const hasDot = normalizedText.includes('.');
    let raw = normalizedText;

    if (hasComma && hasDot) {
      const lastComma = normalizedText.lastIndexOf(',');
      const lastDot = normalizedText.lastIndexOf('.');
      raw =
        lastComma > lastDot
          ? normalizedText.replace(/\./g, '').replace(/,/g, '.')
          : normalizedText.replace(/,/g, '');
    } else if (hasComma) {
      raw = normalizedText.replace(/,/g, '.');
    }

    raw = raw.replace(/[^0-9.-]/g, '');
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private toText(value: unknown) {
    return this.repairText(String(value ?? ''));
  }

  private toFixedText(value: number, decimals: number) {
    return Number.isFinite(value) ? value.toFixed(decimals) : '0';
  }

  private resolveProductoUnitCost(producto: Producto, stock?: StockBodega | null) {
    const productCost = this.toNumber(
      producto.costo_promedio ?? producto.ultimo_costo,
      0,
    );
    if (productCost > 0) return productCost;

    const stockCost = this.toNumber(stock?.costo_promedio_bodega, 0);
    if (stockCost > 0) return stockCost;

    return 0;
  }

  private normalizeHeader(value: string) {
    return this.repairText(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private rowValue(row: Record<string, unknown>, headers: string[]) {
    const keys = Object.keys(row);
    for (const header of headers) {
      const match = keys.find(
        (key) => this.normalizeHeader(key) === this.normalizeHeader(header),
      );
      if (match) return row[match];
    }
    return null;
  }

  private buildCodeFromLabel(value: string, prefix: string) {
    const normalized = this.repairText(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    const compact = normalized.slice(0, 24) || 'GENERAL';
    return `${prefix}_${compact}`;
  }

  private mojibakeScore(value: string) {
    if (!value) return 0;
    const matches = value.match(/Ã.|Â.|â.|�/g);
    return matches?.length ?? 0;
  }

  private repairText(value: string) {
    let text = String(value ?? '').replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
    if (!text) return '';

    const candidates = [text];
    try {
      candidates.push(Buffer.from(text, 'latin1').toString('utf8').trim());
    } catch {
      /* noop */
    }

    const best = candidates
      .filter(Boolean)
      .sort((a, b) => this.mojibakeScore(a) - this.mojibakeScore(b))[0];

    return String(best || text).trim();
  }

  private decodeDelimitedText(buffer: Buffer) {
    const utf8 = this.repairText(buffer.toString('utf8'));
    const latin1 = this.repairText(buffer.toString('latin1'));
    return this.mojibakeScore(utf8) <= this.mojibakeScore(latin1)
      ? utf8
      : latin1;
  }

  private readInventoryWorkbook(
    buffer: Buffer,
    options?: { originalName?: string | null; mimeType?: string | null },
  ) {
    const originalName = this.toText(options?.originalName).toLowerCase();
    const mimeType = this.toText(options?.mimeType).toLowerCase();
    const isCsv =
      originalName.endsWith('.csv') ||
      mimeType.includes('csv') ||
      mimeType.includes('text/plain');

    if (isCsv) {
      const csvText = this.decodeDelimitedText(buffer);
      return XLSX.read(csvText, {
        type: 'string',
        raw: false,
      });
    }

    return XLSX.read(buffer, { type: 'buffer', raw: false });
  }

  private resolveInventoryUnitCost(args: {
    costoPromedio: number;
    ultimoCosto: number;
    costoTotal: number;
    stockObjetivo: number;
  }) {
    if (args.costoPromedio > 0) return args.costoPromedio;
    if (args.ultimoCosto > 0) return args.ultimoCosto;
    if (args.costoTotal > 0 && args.stockObjetivo > 0) {
      return args.costoTotal / args.stockObjetivo;
    }
    return 0;
  }

  private async runInventoryImportJob(
    jobId: string,
    buffer: Buffer,
    options?: {
      requestedBy?: string | null;
      originalName?: string | null;
      mimeType?: string | null;
    },
  ) {
    const job = this.importJobs.get(jobId);
    if (!job) return;

    job.status = 'PROCESSING';
    job.progress = 5;
    job.started_at = new Date().toISOString();
    job.current_step = 'Leyendo archivo y preparando importación.';
    job.error_message = null;

    try {
      const summary = await this.importInventoryWorkbook(buffer, {
        ...options,
        onProgress: async ({ currentIndex, totalRows, currentStep }) => {
          const currentJob = this.importJobs.get(jobId);
          if (!currentJob) return;
          currentJob.current_index = currentIndex;
          currentJob.total_rows = totalRows;
          currentJob.current_step = currentStep;
          const completion =
            totalRows > 0 ? Math.round((currentIndex / totalRows) * 90) : 0;
          currentJob.progress = Math.min(95, Math.max(10, completion));
        },
      });

      job.status = 'COMPLETED';
      job.progress = 100;
      job.finished_at = new Date().toISOString();
      job.current_step = 'Importación finalizada correctamente.';
      job.summary = summary;
      job.current_index = summary.total_filas;
      job.total_rows = summary.total_filas;
      job.error_message = null;
      this.logger.log(
        `Carga de inventario completada. Job=${jobId} Archivo=${job.source_file_name} Procesados=${summary.procesados} Errores=${summary.errores.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = 'FAILED';
      job.progress = 100;
      job.finished_at = new Date().toISOString();
      job.current_step = 'La importación finalizó con error.';
      job.error_message = message;
      this.logger.error(
        `Carga de inventario fallida. Job=${jobId} Archivo=${job.source_file_name}: ${message}`,
      );
      await this.notifyMaintenanceImportLifecycle('failed', jobId);
    }
  }

  private async getOrCreateStockRow(
    manager: EntityManager,
    args: {
      bodegaId: string;
      productoId: string;
      costoPromedio: number;
      userName: string;
    },
  ) {
    const existing = await manager.findOne(StockBodega, {
      where: {
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
        is_deleted: false,
      },
    });

    if (existing) return existing;

    return manager.save(
      StockBodega,
      manager.create(StockBodega, {
        status: 'ACTIVE',
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
        stock_actual: '0.000000',
        stock_min_bodega: '0.000000',
        stock_max_bodega: '0.000000',
        stock_min_global: '0.000000',
        stock_contenedores: '0.000000',
        costo_promedio_bodega: this.toFixedText(args.costoPromedio, 4),
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );
  }

  private async createMovementArtifacts(
    manager: EntityManager,
    args: {
      tipo: MovementType;
      bodegaId: string;
      productoId: string;
      cantidad: number;
      costoUnitario: number;
      stockNuevo: number;
      observacion: string;
      userName: string;
    },
  ) {
    const subtotal = args.cantidad * args.costoUnitario;
    const now = new Date();

    const movimiento = await manager.save(
      MovimientoInventario,
      manager.create(MovimientoInventario, {
        status: 'ACTIVE',
        tipo_movimiento: args.tipo,
        fecha_movimiento: now,
        tipo_cambio: '1',
        total_costos: this.toFixedText(subtotal, 4),
        estado: 'CONFIRMADO',
        observacion: args.observacion,
        bodega_origen_id: args.tipo === 'SALIDA' ? args.bodegaId : null,
        bodega_destino_id: args.tipo === 'INGRESO' ? args.bodegaId : null,
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );

    const detalle = await manager.save(
      MovimientoInventarioDet,
      manager.create(MovimientoInventarioDet, {
        status: 'ACTIVE',
        movimiento_id: movimiento.id,
        producto_id: args.productoId,
        cantidad: this.toFixedText(args.cantidad, 6),
        costo_unitario: this.toFixedText(args.costoUnitario, 4),
        subtotal_costo: this.toFixedText(subtotal, 4),
        observacion: args.observacion,
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );

    const kardex = await manager.save(
      Kardex,
      manager.create(Kardex, {
        status: 'ACTIVE',
        fecha: now,
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
        movimiento_id: movimiento.id,
        movimiento_det_id: detalle.id,
        tipo_movimiento: args.tipo,
        entrada_cantidad: this.toFixedText(
          args.tipo === 'INGRESO' ? args.cantidad : 0,
          6,
        ),
        salida_cantidad: this.toFixedText(
          args.tipo === 'SALIDA' ? args.cantidad : 0,
          6,
        ),
        costo_unitario: this.toFixedText(args.costoUnitario, 4),
        costo_total: this.toFixedText(subtotal, 4),
        saldo_cantidad: this.toFixedText(args.stockNuevo, 6),
        saldo_costo_promedio: this.toFixedText(args.costoUnitario, 4),
        saldo_valorizado: this.toFixedText(
          args.stockNuevo * args.costoUnitario,
          4,
        ),
        observacion: args.observacion,
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );

    return { movimiento, detalle, kardex };
  }

  private async importInventoryRow(
    row: Record<string, unknown>,
    userName: string,
    summary: ImportInventorySummary,
    changedStockIds: Set<string>,
  ) {
    const codSucursal = this.toText(this.rowValue(row, ['Cod. Sucursal']));
    const nomSucursal = this.toText(this.rowValue(row, ['Sucursal']));
    const codBodega = this.toText(this.rowValue(row, ['Cod. Bodega']));
    const nomBodega = this.toText(this.rowValue(row, ['Bodega']));
    const nomLinea = this.toText(this.rowValue(row, ['Linea']));
    const nomCategoria = this.toText(this.rowValue(row, ['Categoria']));
    const codItem = this.toText(this.rowValue(row, ['Cod. Item'])).replace(
      /^'+/,
      '',
    );
    const nomItem = this.toText(this.rowValue(row, ['Item']));
    const costoPromedio = this.toNumber(
      this.rowValue(row, ['Costo promedio', 'Costo']),
      0,
    );
    const precio = this.toNumber(this.rowValue(row, ['Precio']), 0);
    const utilidad = this.toNumber(
      this.rowValue(row, ['% UTILIDAD', '% utilidad', 'Utilidad']),
      0,
    );
    const tipoUnidad = this.toText(this.rowValue(row, ['Tipo de unidad']));
    const porContenedoresRaw = this.toText(
      this.rowValue(row, ['Por contenedores']),
    ).toUpperCase();
    const stockObjetivo = this.toNumber(this.rowValue(row, ['Stock']), 0);
    const stockMinBodega = this.toNumber(
      this.rowValue(row, ['Stock min. bodega', 'Stock min bodega']),
      0,
    );
    const stockMaxBodega = this.toNumber(
      this.rowValue(row, ['Stock max. bodega', 'Stock max bodega']),
      0,
    );
    const stockContenedores = this.toNumber(
      this.rowValue(row, ['Stock contenedores']),
      0,
    );
    const stockMinimo = this.toNumber(
      this.rowValue(row, ['Stock minimo', 'Stock mínimo']),
      0,
    );

    if (!codSucursal || !codBodega || !codItem || !nomItem) {
      return false;
    }

    const porContenedores = ['S', 'SI', 'TRUE', '1'].includes(
      porContenedoresRaw,
    );

    const result = await this.dataSource.transaction(async (manager) => {
      let sucursal = await manager.findOne(Sucursal, {
        where: { codigo: codSucursal, is_deleted: false },
      });
      if (!sucursal) {
        sucursal = await manager.save(
          Sucursal,
          manager.create(Sucursal, {
            status: 'ACTIVE',
            codigo: codSucursal,
            nombre: nomSucursal || codSucursal,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let bodega = await manager.findOne(Bodega, {
        where: {
          codigo: codBodega,
          sucursal_id: sucursal.id,
          is_deleted: false,
        },
      });
      if (!bodega) {
        bodega = await manager.save(
          Bodega,
          manager.create(Bodega, {
            status: 'ACTIVE',
            sucursal_id: sucursal.id,
            codigo: codBodega,
            nombre: nomBodega || codBodega,
            es_principal: false,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const lineaNombre = nomLinea || 'GENERAL';
      const lineaCodigo = this.buildCodeFromLabel(lineaNombre, 'LIN');
      let linea = await manager.findOne(Linea, {
        where: [{ codigo: lineaCodigo, is_deleted: false }, { nombre: lineaNombre, is_deleted: false }],
      });
      if (!linea) {
        linea = await manager.save(
          Linea,
          manager.create(Linea, {
            status: 'ACTIVE',
            codigo: lineaCodigo,
            nombre: lineaNombre,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const categoriaNombre = nomCategoria || 'GENERAL';
      const categoriaCodigo = this.buildCodeFromLabel(categoriaNombre, 'CAT');
      let categoria = await manager.findOne(Categoria, {
        where: [
          { codigo: categoriaCodigo, is_deleted: false },
          { nombre: categoriaNombre, is_deleted: false },
        ],
      });
      if (!categoria) {
        categoria = await manager.save(
          Categoria,
          manager.create(Categoria, {
            status: 'ACTIVE',
            codigo: categoriaCodigo,
            nombre: categoriaNombre,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const unidadNombre = tipoUnidad || 'UNIDAD';
      const unidadCodigo = this.buildCodeFromLabel(unidadNombre, 'UM');
      let unidad = await manager.findOne(UnidadMedida, {
        where: [
          { codigo: unidadCodigo, is_deleted: false },
          { nombre: unidadNombre, is_deleted: false },
        ],
      });
      if (!unidad) {
        unidad = await manager.save(
          UnidadMedida,
          manager.create(UnidadMedida, {
            status: 'ACTIVE',
            codigo: unidadCodigo,
            nombre: unidadNombre,
            es_base: true,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let producto = await manager.findOne(Producto, {
        where: { codigo: codItem, is_deleted: false },
      });
      if (!producto) {
        producto = await manager.save(
          Producto,
          manager.create(Producto, {
            status: 'ACTIVE',
            codigo: codItem,
            nombre: nomItem,
            linea_id: linea.id,
            categoria_id: categoria.id,
            unidad_medida_id: unidad.id,
            por_contenedores: porContenedores,
            es_servicio: false,
            requiere_lote: false,
            requiere_serie: false,
            ultimo_costo: this.toFixedText(costoPromedio, 4),
            costo_promedio: this.toFixedText(costoPromedio, 4),
            precio_venta: this.toFixedText(precio, 4),
            porcentaje_utilidad: this.toFixedText(utilidad, 4),
            created_by: userName,
            updated_by: userName,
          }),
        );
        summary.creados += 1;
      } else {
        producto.nombre = nomItem;
        producto.linea_id = linea.id;
        producto.categoria_id = categoria.id;
        producto.unidad_medida_id = unidad.id;
        producto.por_contenedores = porContenedores;
        producto.ultimo_costo = this.toFixedText(costoPromedio, 4);
        producto.costo_promedio = this.toFixedText(costoPromedio, 4);
        producto.precio_venta = this.toFixedText(precio, 4);
        producto.porcentaje_utilidad = this.toFixedText(utilidad, 4);
        producto.updated_by = userName;
        await manager.save(Producto, producto);
        summary.actualizados += 1;
      }

      const stockRow = await this.getOrCreateStockRow(manager, {
        bodegaId: bodega.id,
        productoId: producto.id,
        costoPromedio,
        userName,
      });
      const stockAnterior = this.toNumber(stockRow.stock_actual, 0);
      const delta = stockObjetivo - stockAnterior;

      stockRow.stock_min_bodega = this.toFixedText(stockMinBodega, 6);
      stockRow.stock_max_bodega = this.toFixedText(stockMaxBodega, 6);
      stockRow.stock_min_global = this.toFixedText(stockMinimo, 6);
      stockRow.stock_contenedores = this.toFixedText(stockContenedores, 6);
      stockRow.costo_promedio_bodega = this.toFixedText(costoPromedio, 4);
      stockRow.updated_by = userName;

      if (delta !== 0) {
        const tipo = delta > 0 ? 'INGRESO' : 'SALIDA';
        const stockNuevo = stockAnterior + delta;
        stockRow.stock_actual = this.toFixedText(stockNuevo, 6);
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);

        await this.createMovementArtifacts(manager, {
          tipo,
          bodegaId: bodega.id,
          productoId: producto.id,
          cantidad: Math.abs(delta),
          costoUnitario: costoPromedio,
          stockNuevo,
          observacion: 'Ajuste por carga masiva XLSX',
          userName,
        });

        if (delta > 0) summary.ingresos += 1;
        else summary.salidas += 1;
      } else {
        stockRow.stock_actual = this.toFixedText(stockObjetivo, 6);
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);
      }

      return true;
    });

    return result;
  }

  private async importInventoryRowNormalized(
    row: Record<string, unknown>,
    userName: string,
    summary: ImportInventorySummary,
    changedStockIds: Set<string>,
  ) {
    const codSucursal = this.toText(this.rowValue(row, ['Cod. Sucursal']));
    const nomSucursal = this.toText(this.rowValue(row, ['Sucursal']));
    const codBodega = this.toText(this.rowValue(row, ['Cod. Bodega']));
    const nomBodega = this.toText(this.rowValue(row, ['Bodega']));
    const codLinea = this.toText(
      this.rowValue(row, ['Cod. Línea', 'Cod. Linea']),
    );
    const nomLinea = this.toText(this.rowValue(row, ['Línea', 'Linea']));
    const tipoProducto = this.toText(this.rowValue(row, ['Tipo']));
    const nomCategoria = this.toText(
      this.rowValue(row, ['Categoría', 'Categoria']),
    );
    const registroSanitario = this.toText(
      this.rowValue(row, [
        'Reg. Sanitario',
        'Reg Sanitario',
        'Registro sanitario',
      ]),
    );
    const marcaNombre = this.toText(this.rowValue(row, ['Marca']));
    const codItem = this.toText(
      this.rowValue(row, ['Cod. Ítem', 'Cod. Item']),
    ).replace(/^['"]+/, '');
    const nomItem = this.toText(this.rowValue(row, ['Ítem', 'Item']));
    const seccion = this.toText(this.rowValue(row, ['Sección', 'Seccion']));
    const nivel = this.toText(this.rowValue(row, ['Nivel']));
    const ultimoCosto = this.toNumber(
      this.rowValue(row, ['Último costo', 'Ultimo costo']),
      0,
    );
    const costoPromedioOrigen = this.toNumber(
      this.rowValue(row, ['Costo promedio']),
      0,
    );
    const costoTotal = this.toNumber(this.rowValue(row, ['Costo']), 0);
    const precio = this.toNumber(this.rowValue(row, ['Precio']), 0);
    const utilidad = this.toNumber(
      this.rowValue(row, ['% UTILIDAD', '% utilidad', 'Utilidad']),
      0,
    );
    const tipoUnidad = this.toText(this.rowValue(row, ['Tipo de unidad']));
    const porContenedoresRaw = this.toText(
      this.rowValue(row, ['Por contenedores']),
    ).toUpperCase();
    const stockObjetivo = this.toNumber(this.rowValue(row, ['Stock']), 0);
    const stockMinBodega = this.toNumber(
      this.rowValue(row, ['Stock min. bodega', 'Stock min bodega']),
      0,
    );
    const stockMaxBodega = this.toNumber(
      this.rowValue(row, ['Stock max. bodega', 'Stock max bodega']),
      0,
    );
    const stockContenedores = this.toNumber(
      this.rowValue(row, ['Stock contenedores']),
      0,
    );
    const stockMinimo = this.toNumber(
      this.rowValue(row, ['Stock minimo', 'Stock mínimo']),
      0,
    );

    if (!codSucursal || !codBodega || !codItem || !nomItem) {
      return false;
    }

    const porContenedores = ['S', 'SI', 'TRUE', '1'].includes(
      porContenedoresRaw,
    );
    const descripcion =
      [tipoProducto, seccion, nivel].filter(Boolean).join(' / ') || null;
    const costoUnitario = this.resolveInventoryUnitCost({
      costoPromedio: costoPromedioOrigen,
      ultimoCosto,
      costoTotal,
      stockObjetivo,
    });
    const normalizedStockMinGlobal = stockMinimo > 0 ? stockMinimo : 2;
    const normalizedStockMinBodega =
      stockMinBodega > 0 ? stockMinBodega : normalizedStockMinGlobal;
    const normalizedStockMaxBodega =
      stockMaxBodega > 0 ? stockMaxBodega : 10000;

    return this.dataSource.transaction(async (manager) => {
      let sucursal = await manager.findOne(Sucursal, {
        where: { codigo: codSucursal, is_deleted: false },
      });
      if (!sucursal) {
        sucursal = await manager.save(
          Sucursal,
          manager.create(Sucursal, {
            status: 'ACTIVE',
            codigo: codSucursal,
            nombre: nomSucursal || codSucursal,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let bodega = await manager.findOne(Bodega, {
        where: {
          codigo: codBodega,
          sucursal_id: sucursal.id,
          is_deleted: false,
        },
      });
      if (!bodega) {
        bodega = await manager.save(
          Bodega,
          manager.create(Bodega, {
            status: 'ACTIVE',
            sucursal_id: sucursal.id,
            codigo: codBodega,
            nombre: nomBodega || codBodega,
            es_principal: false,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const lineaNombre = nomLinea || 'GENERAL';
      const lineaCodigo = codLinea || this.buildCodeFromLabel(lineaNombre, 'LIN');
      let linea = await manager.findOne(Linea, {
        where: [
          { codigo: lineaCodigo, is_deleted: false },
          { nombre: lineaNombre, is_deleted: false },
        ],
      });
      if (!linea) {
        linea = await manager.save(
          Linea,
          manager.create(Linea, {
            status: 'ACTIVE',
            codigo: lineaCodigo,
            nombre: lineaNombre,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const categoriaNombre = nomCategoria || 'GENERAL';
      const categoriaCodigo = this.buildCodeFromLabel(categoriaNombre, 'CAT');
      let categoria = await manager.findOne(Categoria, {
        where: [
          { codigo: categoriaCodigo, is_deleted: false },
          { nombre: categoriaNombre, is_deleted: false },
        ],
      });
      if (!categoria) {
        categoria = await manager.save(
          Categoria,
          manager.create(Categoria, {
            status: 'ACTIVE',
            codigo: categoriaCodigo,
            nombre: categoriaNombre,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let marca: Marca | null = null;
      if (marcaNombre) {
        marca =
          (await manager.findOne(Marca, {
            where: { nombre: marcaNombre, is_deleted: false },
          })) ?? null;
        if (!marca) {
          marca = await manager.save(
            Marca,
            manager.create(Marca, {
              status: 'ACTIVE',
              nombre: marcaNombre,
              created_by: userName,
              updated_by: userName,
            }),
          );
        }
      }

      const unidadNombre = tipoUnidad || 'UNIDAD';
      const unidadCodigo = this.buildCodeFromLabel(unidadNombre, 'UM');
      let unidad = await manager.findOne(UnidadMedida, {
        where: [
          { codigo: unidadCodigo, is_deleted: false },
          { nombre: unidadNombre, is_deleted: false },
        ],
      });
      if (!unidad) {
        unidad = await manager.save(
          UnidadMedida,
          manager.create(UnidadMedida, {
            status: 'ACTIVE',
            codigo: unidadCodigo,
            nombre: unidadNombre,
            es_base: true,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let producto = await manager.findOne(Producto, {
        where: { codigo: codItem, is_deleted: false },
      });
      if (!producto) {
        producto = await manager.save(
          Producto,
          manager.create(Producto, {
            status: 'ACTIVE',
            codigo: codItem,
            nombre: nomItem,
            descripcion,
            linea_id: linea.id,
            categoria_id: categoria.id,
            marca_id: marca?.id ?? null,
            registro_sanitario: registroSanitario || null,
            unidad_medida_id: unidad.id,
            por_contenedores: porContenedores,
            es_servicio: false,
            requiere_lote: false,
            requiere_serie: false,
            ultimo_costo: this.toFixedText(ultimoCosto || costoUnitario, 4),
            costo_promedio: this.toFixedText(costoUnitario, 4),
            precio_venta: this.toFixedText(precio, 4),
            porcentaje_utilidad: this.toFixedText(utilidad, 4),
            created_by: userName,
            updated_by: userName,
          }),
        );
        summary.creados += 1;
      } else {
        producto.nombre = nomItem;
        producto.descripcion = descripcion ?? producto.descripcion ?? null;
        producto.linea_id = linea.id;
        producto.categoria_id = categoria.id;
        producto.marca_id = marca?.id ?? null;
        producto.registro_sanitario = registroSanitario || null;
        producto.unidad_medida_id = unidad.id;
        producto.por_contenedores = porContenedores;
        producto.ultimo_costo = this.toFixedText(ultimoCosto || costoUnitario, 4);
        producto.costo_promedio = this.toFixedText(costoUnitario, 4);
        producto.precio_venta = this.toFixedText(precio, 4);
        producto.porcentaje_utilidad = this.toFixedText(utilidad, 4);
        producto.updated_by = userName;
        await manager.save(Producto, producto);
        summary.actualizados += 1;
      }

      const stockRow = await this.getOrCreateStockRow(manager, {
        bodegaId: bodega.id,
        productoId: producto.id,
        costoPromedio: costoUnitario,
        userName,
      });
      const stockAnterior = this.toNumber(stockRow.stock_actual, 0);
      const delta = stockObjetivo - stockAnterior;

      stockRow.stock_min_bodega = this.toFixedText(normalizedStockMinBodega, 6);
      stockRow.stock_max_bodega = this.toFixedText(normalizedStockMaxBodega, 6);
      stockRow.stock_min_global = this.toFixedText(normalizedStockMinGlobal, 6);
      stockRow.stock_contenedores = this.toFixedText(stockContenedores, 6);
      stockRow.costo_promedio_bodega = this.toFixedText(costoUnitario, 4);
      stockRow.updated_by = userName;

      if (delta !== 0) {
        const tipo = delta > 0 ? 'INGRESO' : 'SALIDA';
        const stockNuevo = stockAnterior + delta;
        stockRow.stock_actual = this.toFixedText(stockNuevo, 6);
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);

        await this.createMovementArtifacts(manager, {
          tipo,
          bodegaId: bodega.id,
          productoId: producto.id,
          cantidad: Math.abs(delta),
          costoUnitario,
          stockNuevo,
          observacion: 'Ajuste por carga masiva CSV/XLSX',
          userName,
        });

        if (delta > 0) summary.ingresos += 1;
        else summary.salidas += 1;
      } else {
        stockRow.stock_actual = this.toFixedText(stockObjetivo, 6);
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);
      }

      return true;
    });
  }

  private getMaintenanceRecalcUrl() {
    const baseUrl = String(
      this.configService.get('KPI_MAINTENANCE_URL') ||
        this.configService.get('MAINTENANCE_SERVICE_URL') ||
        this.configService.get('KPI_MAINTENANCE_INTERNAL_URL') ||
        '',
    )
      .trim()
      .replace(/\/$/, '');

    if (!baseUrl) return null;
    if (baseUrl.endsWith('/alertas/recalcular')) return baseUrl;
    return `${baseUrl}/alertas/recalcular`;
  }

  private async notifyMaintenanceRecalculationForStocks(
    stockIds: Iterable<string>,
    source: string,
  ) {
    const url = this.getMaintenanceRecalcUrl();
    if (!url) return;

    const stockIdList = [...new Set([...stockIds].filter(Boolean))];
    if (!stockIdList.length) return;

    if (source === 'import') {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'inventory-kardex-import-completed',
            stock_count: stockIdList.length,
          }),
        });

        if (!response.ok) {
          this.logger.warn(
            `No se pudo disparar el recálculo de alertas (import:bulk). HTTP ${response.status}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Error notificando recálculo de alertas desde kardex (import:bulk): ${message}`,
        );
      }
      return;
    }

    for (const stockId of stockIdList) {
      if (!stockId) continue;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: `inventory-kardex-${source}`,
            stock_id: stockId,
          }),
        });

        if (!response.ok) {
          this.logger.warn(
            `No se pudo disparar el recálculo de alertas (${source}:${stockId}). HTTP ${response.status}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Error notificando recálculo de alertas desde kardex (${source}:${stockId}): ${message}`,
        );
      }
    }
  }

  private async notifyMaintenanceImportLifecycle(
    stage: 'started' | 'failed',
    jobId: string,
  ) {
    const url = this.getMaintenanceRecalcUrl();
    if (!url) return;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: `inventory-kardex-import-${stage}`,
          job_id: jobId,
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `No se pudo notificar el ciclo de importación (${stage}:${jobId}). HTTP ${response.status}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Error notificando ciclo de importación (${stage}:${jobId}): ${message}`,
      );
    }
  }
}
