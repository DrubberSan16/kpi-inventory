/* Run against an isolated, production-schema PostgreSQL database and the local API.
 * RECEPTION_TEST_DATABASE must end in _e2e. This script never uses an application .env.
 * node scripts/test-warehouse-reception-integration.cjs [--seed-only]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const dbName = process.env.RECEPTION_TEST_DATABASE || 'reception_e2e';
if (!dbName.endsWith('_e2e')) throw new Error('Only an explicitly isolated *_e2e database is allowed.');
const db = new Client({ host: '127.0.0.1', port: 55432, user: 'reception_test', database: dbName });
const base = process.env.RECEPTION_TEST_API || 'http://127.0.0.1:3311/kpi_inventory';
if (!base.startsWith('http://127.0.0.1:')) throw new Error('Local test API required.');
let admin, warehouse, outsider, manager, fixture;
const checks = [];
async function sql(query, values = []) { return (await db.query(query, values)).rows; }
async function insert(table, values) {
  const keys = Object.keys(values);
  return (await sql(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`, Object.values(values)))[0];
}
const actorHeaders = actor => ({'X-User-Id':actor.id,'X-User-Name':actor.name_user,'X-Role-Name':actor.roleName});
async function api(method, suffix, body, actor = admin, expected = 200) {
  const response = await fetch(base + suffix, {method,headers:{'Content-Type':'application/json',...actorHeaders(actor)},body:body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json();
  const ok = Array.isArray(expected) ? expected.includes(response.status) : response.status === expected;
  assert(ok, `${method} ${suffix}: expected ${expected}, got ${response.status}: ${JSON.stringify(result)}`);
  return result.data === undefined ? result : result.data;
}
const check = (name, operation) => operation().then(()=>{checks.push(name); console.log('PASS '+name);});
async function seed() {
  const prefix='RECEPTION-'+Date.now();
  const srcBranch=await insert('kpi_inventory.tb_sucursal',{codigo:prefix+'-S',nombre:'Sucursal origen de prueba'});
  const dstBranch=await insert('kpi_inventory.tb_sucursal',{codigo:prefix+'-D',nombre:'Sucursal destino de prueba'});
  const thirdBranch=await insert('kpi_inventory.tb_sucursal',{codigo:prefix+'-X',nombre:'Sucursal ajena de prueba'});
  const source=await insert('kpi_inventory.tb_bodega',{codigo:prefix+'-S',nombre:'Origen recepción prueba',sucursal_id:srcBranch.id,direccion:'Dirección de prueba origen'});
  const destination=await insert('kpi_inventory.tb_bodega',{codigo:prefix+'-D',nombre:'Destino recepción prueba',sucursal_id:dstBranch.id,direccion:'Dirección de prueba destino'});
  await insert('kpi_inventory.tb_sri_emission_config',{sucursal_id:srcBranch.id,ruc:'1790012345001',razon_social:'Empresa de prueba local',dir_matriz:'Dirección local de prueba',estab:'001',pto_emi:'001',ambiente_default:'PRUEBAS'});
  const products=[];
  for (let n=0;n<3;n++) products.push(await insert('kpi_inventory.tb_producto',{codigo:prefix+'-P'+n,nombre:['Material con entrega parcial','Material faltante','Material de compra'][n],ultimo_costo:5,costo_promedio:5}));
  const bcrypt=require(path.resolve(__dirname,'../../kpi-security/node_modules/bcrypt'));
  const passwordHash=await bcrypt.hash('Reception-local-test-2026',4);
  const users=[];
  for (const [roleName,suffix] of [['Super Administrador','admin'],['Bodega','warehouse'],['Bodega','outsider'],['Gerente General','manager']]) {
    let [role]=await sql('SELECT * FROM kpi_security.tb_role WHERE nombre=$1',[roleName]);
    if(!role) role=await insert('kpi_security.tb_role',{nombre:roleName,status:'ACTIVE'});
    const u=await insert('kpi_security.tb_user',{name_user:prefix+'-'+suffix,pass_user:passwordHash,name_surname:'Prueba '+suffix,role_id:role.id,email:suffix+'@example.invalid',status:'ACTIVE'});
    u.roleName=roleName;users.push(u);
    if(suffix==='warehouse'||suffix==='outsider') await insert('kpi_security.tb_user_sucursal',{user_id:u.id,sucursal_id:suffix==='warehouse'?dstBranch.id:thirdBranch.id});
  }
  [admin,warehouse,outsider,manager]=users;
  let [parent]=await sql("SELECT * FROM kpi_security.tb_menu WHERE nombre='Inventario recepción prueba'");
  if(!parent) parent=await insert('kpi_security.tb_menu',{nombre:'Inventario recepción prueba',menu_position:5,status:'ACTIVE',url_component:'/'});
  let [transferMenu]=await sql("SELECT * FROM kpi_security.tb_menu WHERE url_component='transferencias-bodega'");
  if(!transferMenu) transferMenu=await insert('kpi_security.tb_menu',{nombre:'Transferencia Bodega',menu_id:parent.id,menu_position:2,status:'ACTIVE',url_component:'transferencias-bodega'});
  await db.query(fs.readFileSync(path.resolve(__dirname,'../sql/20261010_warehouse_reception_menu.sql'),'utf8'));
  for (const u of users) for(const menuId of [parent.id,transferMenu.id]) {
    await sql(`INSERT INTO kpi_security.tb_menu_user(user_id,menu_id,status,is_readed,is_created,is_edited,is_reports) VALUES($1,$2,'ACTIVE',true,true,true,true) ON CONFLICT DO NOTHING`,[u.id,menuId]);
  }
  fixture={prefix,source,destination,srcBranch,dstBranch,thirdBranch,products,users:users.map(({pass_user,...u})=>u)};
  fs.writeFileSync(path.resolve(__dirname,'../../outputs/20261010-reception-e2e-fixture.json'),JSON.stringify(fixture,null,2));
  return fixture;
}
async function balance(product,warehouseId) {
  const [row]=await sql('SELECT stock_actual,stock_nuevo,stock_usado FROM kpi_inventory.tb_stock_bodega WHERE producto_id=$1 AND bodega_id=$2',[product.id,warehouseId]);
  return row?Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)])):{stock_actual:0,stock_nuevo:0,stock_usado:0};
}
async function commitQuantity(product) {
  const [row]=await sql('SELECT cantidad_total FROM kpi_inventory.v_transferencia_stock_pendiente WHERE producto_id=$1 AND bodega_id=$2',[product.id,fixture.source.id]);return Number(row?.cantidad_total||0);
}
const doc = (kind, product, quantity, condition='NUEVO') => ({tipo_movimiento:kind,bodega_id:fixture.source.id,referencia:fixture.prefix,created_by:admin.name_user,detalles:[{producto_id:product.id,cantidad:quantity,condicion_material:condition,costo_unitario:5}]});
const transferPayload = details => ({bodega_origen_id:fixture.source.id,bodega_destino_id:fixture.destination.id,created_by:admin.name_user,detalles:details});
async function run() {
  await db.connect();await seed();
  if(process.argv.includes('--seed-only')) {console.log('Local fixtures seeded');return;}
  const [product,missing,purchase]=fixture.products;
  await api('POST','/kardex/documentos',doc('INGRESO',product,40),admin,201);
  await api('POST','/kardex/documentos',doc('INGRESO',product,20,'USADO'),admin,201);
  await api('POST','/kardex/documentos',doc('INGRESO',missing,8),admin,201);
  let transfer;
  await check('Create pending transfer preserves both balances and commits new/used stock',async()=>{
    transfer=await api('POST','/transferencias-bodega',transferPayload([{producto_id:product.id,cantidad:10,condicion_material:'NUEVO'},{producto_id:product.id,cantidad:5,condicion_material:'USADO'},{producto_id:missing.id,cantidad:8}]),admin,201);
    assert.equal(transfer.estado,'PENDIENTE_RECEPCION');assert.equal((await balance(product,fixture.source.id)).stock_actual,60);assert.equal((await balance(product,fixture.destination.id)).stock_actual,0);assert.equal(await commitQuantity(product),15);
    const [{n}]=await sql("SELECT count(*) n FROM kpi_inventory.tb_kardex WHERE movimiento_id IN (SELECT id FROM kpi_inventory.tb_movimiento_inventario WHERE referencia=$1)",[transfer.codigo]);assert.equal(Number(n),0);
  });
  const [newLine,usedLine,missingLine]=transfer.detalles;
  await check('Another transfer cannot overcommit pending new stock',async()=>{await api('POST','/transferencias-bodega',transferPayload([{producto_id:product.id,cantidad:31,condicion_material:'NUEVO'}]),admin,400);});
  await check('Manual warehouse withdrawal cannot consume pending stock',async()=>{await api('POST','/kardex/documentos',doc('SALIDA',product,31),admin,400);});
  await check('Guide can be prepared before inventory receipt',async()=>{const guide=await api('GET','/guias-remision-sri/prepare/'+transfer.id);assert(guide);});
  await check('Destination authorization rejects users from another branch',async()=>{await api('POST',`/transferencias-bodega/${transfer.id}/recepciones`,{idempotency_key:randomUUID(),detalles:[{transferencia_detalle_id:newLine.id,llego:true,cantidad_recibida:1}]},outsider,403);});
  await check('Read-only management cannot approve receipts',async()=>{await api('POST',`/transferencias-bodega/${transfer.id}/recepciones`,{idempotency_key:randomUUID(),detalles:[{transferencia_detalle_id:newLine.id,llego:true,cantidad_recibida:1}]},manager,403);});
  let receipt;
  const receiptBody={idempotency_key:randomUUID(),observacion:'Revisión parcial de prueba',detalles:[
    {transferencia_detalle_id:newLine.id,llego:true,cantidad_recibida:4,observacion:'Cuatro unidades completas',adjuntos:[{nombre:'evidencia.pdf',mime_type:'application/pdf',contenido_base64:Buffer.from('%PDF-1.4\nEvidencia prueba\n%%EOF').toString('base64')}]},
    {transferencia_detalle_id:usedLine.id,llego:true,cantidad_recibida:2},
    {transferencia_detalle_id:missingLine.id,llego:false,cantidad_recibida:0,observacion:'No llegó este material'},
  ]};
  await check('Draft stores evidence and missing material without moving stock',async()=>{receipt=await api('POST',`/transferencias-bodega/${transfer.id}/recepciones`,receiptBody,warehouse,201);assert.equal(receipt.estado,'BORRADOR');assert.equal((await balance(product,fixture.source.id)).stock_actual,60);assert.equal((await balance(product,fixture.destination.id)).stock_actual,0);});
  await check('Repeated draft request is idempotent',async()=>{const repeated=await api('POST',`/transferencias-bodega/${transfer.id}/recepciones`,receiptBody,warehouse,201);assert.equal(repeated.id,receipt.id);});
  await check('Concurrent approval applies each new/used quantity exactly once',async()=>{
    const suffix=`/transferencias-bodega/${transfer.id}/recepciones/${receipt.id}/aprobar`;
    await Promise.all([api('PATCH',suffix,undefined,warehouse),api('PATCH',suffix,undefined,warehouse)]);
    assert.deepEqual(await balance(product,fixture.source.id),{stock_actual:54,stock_nuevo:36,stock_usado:18});assert.deepEqual(await balance(product,fixture.destination.id),{stock_actual:6,stock_nuevo:4,stock_usado:2});assert.equal(await commitQuantity(product),9);assert.equal((await balance(missing,fixture.destination.id)).stock_actual,0);
    const [{n}]=await sql('SELECT count(*) n FROM kpi_inventory.tb_kardex WHERE movimiento_id IN (SELECT id FROM kpi_inventory.tb_movimiento_inventario WHERE referencia=$1)',[transfer.codigo]);assert.equal(Number(n),4);
    const row=await api('GET','/transferencias-bodega/'+transfer.id);assert.equal(row.estado,'PARCIALMENTE_RECIBIDA');
  });
  await check('Attachments download only through authorized receipt scope',async()=>{
    const rows=await sql('SELECT a.id FROM kpi_inventory.tb_recepcion_bodega_adjunto a JOIN kpi_inventory.tb_recepcion_bodega_det d ON d.id=a.recepcion_detalle_id WHERE d.recepcion_bodega_id=$1',[receipt.id]);assert.equal(rows.length,1);
    const suffix=`/transferencias-bodega/${transfer.id}/recepciones/${receipt.id}/adjuntos/${rows[0].id}`;
    const response=await fetch(base+suffix,{headers:actorHeaders(warehouse)});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');assert((await response.text()).startsWith('%PDF'));
    await api('GET',suffix,undefined,outsider,403);
  });
  await check('Over-receipt and invalid evidence are rejected without balance changes',async()=>{
    await api('POST',`/transferencias-bodega/${transfer.id}/recepciones`,{idempotency_key:randomUUID(),detalles:[{transferencia_detalle_id:newLine.id,llego:true,cantidad_recibida:7}]},warehouse,400);
    await api('POST',`/transferencias-bodega/${transfer.id}/recepciones`,{idempotency_key:randomUUID(),detalles:[{transferencia_detalle_id:newLine.id,llego:true,cantidad_recibida:1,adjuntos:[{nombre:'unsafe.pdf',mime_type:'application/pdf',contenido_base64:Buffer.from('not a PDF').toString('base64')}]}]},warehouse,400);
  });
  await check('Second receipt completes transfer, releases commitment and preserves all history',async()=>{
    const next=await api('POST',`/transferencias-bodega/${transfer.id}/recepciones`,{idempotency_key:randomUUID(),detalles:[{transferencia_detalle_id:newLine.id,llego:true,cantidad_recibida:6},{transferencia_detalle_id:usedLine.id,llego:true,cantidad_recibida:3},{transferencia_detalle_id:missingLine.id,llego:true,cantidad_recibida:8}]},warehouse,201);
    await api('PATCH',`/transferencias-bodega/${transfer.id}/recepciones/${next.id}/aprobar`,undefined,warehouse);
    const row=await api('GET','/transferencias-bodega/'+transfer.id);assert.equal(row.estado,'COMPLETADA');assert.equal(row.recepciones.length,2);assert.equal(await commitQuantity(product),0);assert.equal((await balance(product,fixture.destination.id)).stock_actual,15);assert.equal((await balance(missing,fixture.destination.id)).stock_actual,8);
  });
  await check('Completed annulment/reversal restore exact balances and receipt state',async()=>{
    await api('PATCH',`/transferencias-bodega/${transfer.id}/anular`);assert.equal((await balance(product,fixture.destination.id)).stock_actual,0);assert.equal((await balance(product,fixture.source.id)).stock_actual,60);
    await api('PATCH',`/transferencias-bodega/${transfer.id}/reversar-anulacion`);assert.equal((await balance(product,fixture.destination.id)).stock_actual,15);assert.equal((await balance(product,fixture.source.id)).stock_actual,45);
  });
  await check('Purchase receipt is separated from destination acceptance and pending quantities',async()=>{
    const order=await insert('kpi_inventory.tb_orden_compra',{codigo:fixture.prefix+'-OC',bodega_destino_id:fixture.source.id,estado:'EMITIDA'});
    const od=await insert('kpi_inventory.tb_orden_compra_det',{orden_compra_id:order.id,producto_id:purchase.id,nombre_producto:purchase.nombre,cantidad:12,cantidad_preaprobada:12,cantidad_recibida:0,cantidad_transferida:0,costo_unitario:5});
    const t=await api('POST','/transferencias-bodega',{...transferPayload([{producto_id:purchase.id,orden_compra_det_id:od.id,cantidad:10}]),orden_compra_id:order.id},admin,201);
    assert.equal((await balance(purchase,fixture.source.id)).stock_actual,12);assert.equal((await balance(purchase,fixture.destination.id)).stock_actual,0);
    const r=await api('POST',`/transferencias-bodega/${t.id}/recepciones`,{idempotency_key:randomUUID(),detalles:[{transferencia_detalle_id:t.detalles[0].id,llego:true,cantidad_recibida:4}]},warehouse,201);
    await api('PATCH',`/transferencias-bodega/${t.id}/recepciones/${r.id}/aprobar`,undefined,warehouse);
    const [detail]=await sql('SELECT cantidad_recibida,cantidad_transferida FROM kpi_inventory.tb_orden_compra_det WHERE id=$1',[od.id]);assert.equal(Number(detail.cantidad_recibida),12);assert.equal(Number(detail.cantidad_transferida),4);assert.equal(await commitQuantity(purchase),6);
    await api('PATCH',`/transferencias-bodega/${t.id}/anular`);assert.equal((await balance(purchase,fixture.source.id)).stock_actual,12);assert.equal((await balance(purchase,fixture.destination.id)).stock_actual,0);assert.equal(await commitQuantity(purchase),0);
  });
  const pending=await api('POST','/transferencias-bodega',transferPayload([{producto_id:product.id,cantidad:3,condicion_material:'NUEVO'}]),admin,201);
  await check('Annul pending transfer releases commitment without inventory movements',async()=>{const before=await balance(product,fixture.source.id);await api('PATCH',`/transferencias-bodega/${pending.id}/anular`);assert.deepEqual(await balance(product,fixture.source.id),before);assert.equal(await commitQuantity(product),0);});
  // Leave a separate pending receipt for browser E2E; all records belong only to this local test DB.
  await api('POST','/kardex/documentos',doc('INGRESO',missing,4),admin,201);
  const browserTransfer=await api('POST','/transferencias-bodega',transferPayload([{producto_id:product.id,cantidad:3,condicion_material:'NUEVO'},{producto_id:missing.id,cantidad:2}]),admin,201);
  fixture.browserTransfer=browserTransfer;fixture.checks=checks;
  fs.writeFileSync(path.resolve(__dirname,'../../outputs/20261010-reception-e2e-fixture.json'),JSON.stringify(fixture,null,2));
  console.log(JSON.stringify({checks:checks.length,db:dbName,browserTransfer:browserTransfer.codigo}));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.end());
