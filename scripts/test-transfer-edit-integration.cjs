/* Local API + isolated production-schema database only. No application .env.
 * TB_EDIT_TEST_DATABASE must end in _e2e; run after npm run build.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const database = process.env.TB_EDIT_TEST_DATABASE || 'tb_edit_e2e';
const base = process.env.TB_EDIT_TEST_API || 'http://127.0.0.1:3314/kpi_inventory';
if (!database.endsWith('_e2e') || new URL(base).hostname !== '127.0.0.1') {
  throw new Error('An isolated *_e2e database and loopback API are required.');
}
const db = new Client({ host: '127.0.0.1', port: Number(process.env.TB_EDIT_TEST_PORT || 55434), user: process.env.TB_EDIT_TEST_USER || 'tb_edit_test', database });
const prefix = 'EDIT-' + Date.now();
const sql = async (text, args = []) => (await db.query(text, args)).rows;
async function insert(table, value) {
  const keys = Object.keys(value);
  return (await sql(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, Object.values(value)))[0];
}
let admin;
async function api(method, suffix, body, actor = admin, expected = 200) {
  const response = await fetch(base + suffix, {
    method, headers: { 'Content-Type': 'application/json', 'X-User-Id': actor.id, 'X-User-Name': actor.name_user, 'X-Role-Name': actor.roleName },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${suffix}: ${JSON.stringify(value)}`);
  return value.data === undefined ? value : value.data;
}
const checks = [];
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
const get = (id, actor) => api('GET', '/transferencias-bodega/' + id, undefined, actor);
function payload(t, overrides = {}) {
  return {
    orden_compra_id: t.orden_compra_id || undefined, bodega_origen_id: t.bodega_origen_id,
    bodega_destino_id: t.bodega_destino_id, fecha_transferencia: '2026-11-14',
    observacion: 'Correccion local', expected_version: t.version_edicion,
    detalles: t.detalles.map(d => ({ producto_id: d.producto_id, orden_compra_det_id: d.orden_compra_det_id || undefined, condicion_material: d.condicion_material, cantidad: Number(d.cantidad), observacion: d.observacion || undefined })),
    ...overrides,
  };
}
async function run() {
  await db.connect();
  const branches = [];
  for (const name of ['Origen', 'Destino', 'MATRIZ']) {
    branches.push(await insert('kpi_inventory.tb_sucursal', { codigo: prefix + '-' + branches.length, nombre: name }));
  }
  const warehouses = [];
  for (const branch of branches) warehouses.push(await insert('kpi_inventory.tb_bodega', { codigo: prefix + '-' + warehouses.length, nombre: branch.nombre, sucursal_id: branch.id, direccion: 'Direccion local de prueba' }));
  const [source, destination, matrix] = warehouses;
  const users = [];
  for (const [i, roleName] of ['Super Administrador', 'Administrador', 'Gerente General', 'Bodega', 'Bodega', 'Supervisor'].entries()) {
    let [role] = await sql('SELECT id FROM kpi_security.tb_role WHERE nombre=$1', [roleName]);
    role ||= await insert('kpi_security.tb_role', { nombre: roleName, status: 'ACTIVE' });
    const user = await insert('kpi_security.tb_user', { name_user: prefix + '-' + i, name_surname: 'Prueba local', pass_user: 'disabled-test-login', status: 'ACTIVE', role_id: role.id, email: `test-${i}@example.invalid` });
    users.push({ ...user, roleName });
  }
  [admin] = users;
  const keeper = users[3], destinationKeeper = users[4];
  for (const [user, branch] of [[keeper, branches[0]], [keeper, branches[2]], [destinationKeeper, branches[1]], [users[5], branches[0]]]) {
    await insert('kpi_security.tb_user_sucursal', { user_id: user.id, sucursal_id: branch.id });
  }
  let [menu] = await sql("SELECT id FROM kpi_security.tb_menu WHERE url_component='transferencias-bodega'");
  menu ||= await insert('kpi_security.tb_menu', { nombre: prefix, url_component: 'transferencias-bodega', status: 'ACTIVE', menu_position: 1 });
  for (const user of users) await insert('kpi_security.tb_menu_user', { user_id: user.id, menu_id: menu.id, status: 'ACTIVE', is_readed: true, is_created: true, is_edited: true });
  const products = [];
  for (let i = 0; i < 3; i++) products.push(await insert('kpi_inventory.tb_producto', { codigo: prefix + '-P' + i, nombre: 'Material prueba ' + i, costo_promedio: 5, ultimo_costo: 5 }));
  for (const warehouse of [source, matrix]) for (const product of products) {
    await insert('kpi_inventory.tb_stock_bodega', { bodega_id: warehouse.id, producto_id: product.id, stock_actual: 120, stock_nuevo: 100, stock_usado: 20, stock_fisico: 120, costo_promedio_bodega: 5 });
  }
  const line = (quantity, product = products[0], condition = 'NUEVO') => ({ producto_id: product.id, condicion_material: condition, cantidad: quantity });
  const create = (from = source, details = [line(10)]) => api('POST', '/transferencias-bodega', { bodega_origen_id: from.id, bodega_destino_id: destination.id, detalles: details }, admin, 201);
  const edit = (t, body = payload(t), actor = admin, status = 200) => api('PATCH', '/transferencias-bodega/' + t.id, body, actor, status);
  let transfer = await create();
  const original = await get(transfer.id);
  await check('Administracion y Bodega origen pueden editar; destino y otros roles no', async () => {
    for (const user of users.slice(0, 4)) assert.equal((await get(transfer.id, user)).puede_editar, true);
    for (const user of users.slice(4)) {
      assert.equal((await get(transfer.id, user)).puede_editar, false);
      await edit(original, payload(original), user, 403);
    }
  });
  await check('Permiso Editar individual habilita y revoca acceso para cada rol, incluido Super Administrador', async () => {
    for (const user of users.slice(0, 4)) {
      await sql('UPDATE kpi_security.tb_menu_user SET is_edited=false WHERE user_id=$1 AND menu_id=$2', [user.id, menu.id]);
      assert.equal((await get(transfer.id, user)).puede_editar, false);
      await edit(original, payload(original), user, 403);
      await sql('UPDATE kpi_security.tb_menu_user SET is_edited=true WHERE user_id=$1 AND menu_id=$2', [user.id, menu.id]);
      assert.equal((await get(transfer.id, user)).puede_editar, true);
    }
  });
  await check('Editar conserva ID, codigo, creador, stock y recalcula reserva', async () => {
    const before = await sql('SELECT stock_actual FROM kpi_inventory.tb_stock_bodega WHERE bodega_id=$1 AND producto_id=$2', [source.id, products[0].id]);
    transfer = await edit(original, payload(original, { detalles: [line(15)] }), keeper);
    assert.equal(transfer.id, original.id); assert.equal(transfer.codigo, original.codigo);
    assert.equal(transfer.created_by, original.created_by); assert.equal(Number(transfer.total_cantidad), 15);
    assert.deepEqual(await sql('SELECT stock_actual FROM kpi_inventory.tb_stock_bodega WHERE bodega_id=$1 AND producto_id=$2', [source.id, products[0].id]), before);
    const [pending] = await sql('SELECT cantidad_total FROM kpi_inventory.v_transferencia_stock_pendiente WHERE bodega_id=$1 AND producto_id=$2', [source.id, products[0].id]);
    assert.equal(Number(pending.cantidad_total), 15);
    assert.equal((await sql('SELECT k.id FROM kpi_inventory.tb_kardex k JOIN kpi_inventory.tb_movimiento_inventario m ON m.id=k.movimiento_id WHERE m.referencia=$1', [original.codigo])).length, 0);
  });
  await check('Version antigua se rechaza sin sobrescribir', async () => { await edit(original, payload(original), keeper, 409); });
  await check('Stock insuficiente revierte toda la edicion', async () => {
    const current = await get(transfer.id);
    await edit(current, payload(current, { detalles: [line(9999)] }), keeper, 400);
    const after = await get(transfer.id);
    assert.equal(after.updated_at, current.updated_at); assert.deepEqual(after.detalles, current.detalles);
  });
  await check('Bodega no puede mover el origen a otra sucursal ni matriz', async () => {
    const current = await get(transfer.id);
    await edit(current, payload(current, { bodega_origen_id: matrix.id }), keeper, 403);
  });
  await check('Matriz es exclusiva de perfiles administrativos incluso con asignacion', async () => {
    const t = await create(matrix);
    assert.equal((await get(t.id, keeper)).puede_editar, false);
    await edit(await get(t.id), payload(await get(t.id)), keeper, 403);
    for (const user of users.slice(0, 3)) await edit(await get(t.id), payload(await get(t.id)), user);
  });
  await check('Agregar y quitar materiales conserva condiciones y cantidades decimales', async () => {
    const current = await get(transfer.id);
    const changed = await edit(current, payload(current, { detalles: [line(2.123456, products[1]), line(3, products[1], 'USADO')] }), keeper);
    assert.equal(changed.detalles.length, 2);
    assert.deepEqual(changed.detalles.map(d => [d.condicion_material, Number(d.cantidad)]).sort(), [['NUEVO', 2.123456], ['USADO', 3]]);
    const [pending] = await sql('SELECT COALESCE(SUM(cantidad_total),0) n FROM kpi_inventory.v_transferencia_stock_pendiente WHERE bodega_id=$1 AND producto_id=$2', [source.id, products[0].id]);
    assert.equal(Number(pending.n), 0);
  });
  await check('Dos ediciones simultaneas no se pisan', async () => {
    const current = await get(transfer.id);
    const request = () => fetch(base + '/transferencias-bodega/' + current.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-User-Id': keeper.id, 'X-Role-Name': keeper.roleName }, body: JSON.stringify(payload(current)) });
    const results = await Promise.all([request(), request()]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  });
  await check('Recepcion activa bloquea; cancelada permite editar nuevamente', async () => {
    const t = await create();
    const receipt = await api('POST', `/transferencias-bodega/${t.id}/recepciones`, { idempotency_key: randomUUID(), detalles: [{ transferencia_detalle_id: t.detalles[0].id, llego: true, cantidad_recibida: 1 }] }, admin, 201);
    assert.equal((await get(t.id)).puede_editar, false);
    await edit(t, payload(t), admin, 400);
    await api('PATCH', `/transferencias-bodega/${t.id}/recepciones/${receipt.id}/cancelar`);
    assert.equal((await get(t.id)).puede_editar, true);
    await edit(await get(t.id));
  });
  await check('Recepcion aprobada bloquea y conserva movimientos', async () => {
    const t = await create();
    const receipt = await api('POST', `/transferencias-bodega/${t.id}/recepciones`, { idempotency_key: randomUUID(), detalles: [{ transferencia_detalle_id: t.detalles[0].id, llego: true, cantidad_recibida: 1 }] }, admin, 201);
    await api('PATCH', `/transferencias-bodega/${t.id}/recepciones/${receipt.id}/aprobar`);
    const current = await get(t.id); assert.equal(current.puede_editar, false);
    await edit(current, payload(current), admin, 400);
  });
  const config = await insert('kpi_inventory.tb_sri_emission_config', { sucursal_id: branches[0].id, ruc: '1790012345001', razon_social: 'Prueba local', dir_matriz: 'Direccion local', estab: '001', pto_emi: '001', ambiente_default: 'PRUEBAS' });
  await check('Toda guia generada bloquea, incluyendo anulada y eliminada logicamente', async () => {
    const t = await create();
    const guide = await insert('kpi_inventory.tb_guia_remision_electronica', { transferencia_bodega_id: t.id, sri_config_id: config.id, ambiente: 'PRUEBAS', clave_acceso: randomUUID(), estab: '001', pto_emi: '001', secuencial: '000000001', fecha_emision: '2026-11-14', fecha_ini_transporte: '2026-11-14', fecha_fin_transporte: '2026-11-14', dir_partida: 'Local', razon_social_transportista: 'Prueba', tipo_identificacion_transportista: '04', identificacion_transportista: '1790012345001', placa: 'AAA0001', identificacion_destinatario: '1790012345001', razon_social_destinatario: 'Prueba', dir_destinatario: 'Local', motivo_traslado: 'Prueba', estado_emision: 'GENERADA' });
    for (const state of ['GENERADA', 'ANULADA']) {
      await sql('UPDATE kpi_inventory.tb_guia_remision_electronica SET estado_emision=$1,is_deleted=$2 WHERE id=$3', [state, state === 'ANULADA', guide.id]);
      assert.equal((await get(t.id)).puede_editar, false);
      await edit(t, payload(t), admin, 400);
    }
  });
  await check('Editar una TB de compra no duplica el ingreso ni cambia la OC', async () => {
    const order = await insert('kpi_inventory.tb_orden_compra', { codigo: prefix + '-OC', bodega_destino_id: source.id, estado: 'EMITIDA' });
    const od = await insert('kpi_inventory.tb_orden_compra_det', { orden_compra_id: order.id, producto_id: products[2].id, nombre_producto: products[2].nombre, cantidad: 10, cantidad_preaprobada: 10, costo_unitario: 5, subtotal: 50 });
    const t = await api('POST', '/transferencias-bodega', { orden_compra_id: order.id, bodega_destino_id: destination.id, detalles: [{ producto_id: products[2].id, orden_compra_det_id: od.id, cantidad: 4 }] }, admin, 201);
    const before = await sql('SELECT stock_actual FROM kpi_inventory.tb_stock_bodega WHERE bodega_id=$1 AND producto_id=$2', [source.id, products[2].id]);
    const updated = await edit(t, payload(t, { detalles: [{ producto_id: products[2].id, orden_compra_det_id: od.id, cantidad: 7 }] }));
    assert.equal(updated.movimiento_recepcion_id, t.movimiento_recepcion_id);
    assert.deepEqual(await sql('SELECT stock_actual FROM kpi_inventory.tb_stock_bodega WHERE bodega_id=$1 AND producto_id=$2', [source.id, products[2].id]), before);
    await edit(updated, payload(updated, { orden_compra_id: undefined }), admin, 400);
    const other = await api('POST', '/transferencias-bodega', { orden_compra_id: order.id, bodega_destino_id: destination.id, detalles: [{ producto_id: products[2].id, orden_compra_det_id: od.id, cantidad: 3 }] }, admin, 201);
    await edit(updated, payload(updated, { detalles: [{ producto_id: products[2].id, orden_compra_det_id: od.id, cantidad: 8 }] }), admin, 400);
    assert(other.id !== updated.id);
  });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.end());
