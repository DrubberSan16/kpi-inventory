-- Recepción de bodega: menú y permisos iniciales. Ejecutar en JUSTICE_KPI.
-- No modifica permisos existentes ni reactiva asignaciones revocadas.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE
  v_menu uuid;
  v_parent uuid;
BEGIN
  SELECT menu_id INTO v_parent FROM kpi_security.tb_menu
   WHERE url_component = 'transferencias-bodega' AND NOT is_deleted LIMIT 1;
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'No existe el menú activo de transferencias de bodega';
  END IF;
  SELECT id INTO v_menu FROM kpi_security.tb_menu
   WHERE url_component = 'recepciones-bodega' LIMIT 1;
  IF v_menu IS NULL THEN
    v_menu := gen_random_uuid();
    INSERT INTO kpi_security.tb_menu
      (id,nombre,descripcion,menu_id,url_component,menu_position,status,icon,created_by,updated_by)
    VALUES
      (v_menu,'Recepción de bodega','Revisión y aprobación de materiales enviados entre bodegas',
       v_parent,'recepciones-bodega',3,'ACTIVE','mdi-clipboard-check-outline',
       'migration:warehouse-reception','migration:warehouse-reception');
  END IF;
  INSERT INTO kpi_security.tb_menu_role
    (role_id,menu_id,status,is_readed,is_created,is_edited,is_deleted,is_reports,created_by,updated_by)
  SELECT r.id,v_menu,'ACTIVE',true,
    upper(r.nombre) <> 'GERENTE GENERAL',upper(r.nombre) <> 'GERENTE GENERAL',false,true,
    'migration:warehouse-reception','migration:warehouse-reception'
  FROM kpi_security.tb_role r
  WHERE NOT r.is_deleted AND r.status='ACTIVE'
    AND upper(r.nombre) IN ('ADMINISTRADOR','SUPER ADMINISTRADOR','GERENTE GENERAL','BODEGA')
    AND NOT EXISTS (SELECT 1 FROM kpi_security.tb_menu_role mr WHERE mr.role_id=r.id AND mr.menu_id=v_menu);
  INSERT INTO kpi_security.tb_menu_user
    (user_id,menu_id,status,is_readed,is_created,is_edited,is_deleted,is_reports,created_by,updated_by)
  SELECT u.id,v_menu,'ACTIVE',true,
    upper(r.nombre) <> 'GERENTE GENERAL',upper(r.nombre) <> 'GERENTE GENERAL',false,true,
    'migration:warehouse-reception','migration:warehouse-reception'
  FROM kpi_security.tb_user u JOIN kpi_security.tb_role r ON r.id=u.role_id
  WHERE NOT u.is_deleted AND u.status='ACTIVE' AND NOT r.is_deleted AND r.status='ACTIVE'
    AND upper(r.nombre) IN ('ADMINISTRADOR','SUPER ADMINISTRADOR','GERENTE GENERAL','BODEGA')
    AND NOT EXISTS (SELECT 1 FROM kpi_security.tb_menu_user mu WHERE mu.user_id=u.id AND mu.menu_id=v_menu);
  -- buildMenuTree necesita la cadena de padres para mostrar el nuevo hijo.
  INSERT INTO kpi_security.tb_menu_user
    (user_id,menu_id,status,is_readed,is_created,is_edited,is_deleted,is_reports,created_by,updated_by)
  SELECT mu.user_id,v_parent,'ACTIVE',true,false,false,false,false,
    'migration:warehouse-reception','migration:warehouse-reception'
  FROM kpi_security.tb_menu_user mu
  WHERE mu.menu_id=v_menu AND NOT mu.is_delete AND mu.status='ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM kpi_security.tb_menu_user p WHERE p.user_id=mu.user_id AND p.menu_id=v_parent);
END $$;
COMMIT;
