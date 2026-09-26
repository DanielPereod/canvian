-- El mapa de secciones es ahora la única vista: la sección madre de cada nota
-- (y de cada subsección) se guarda en zone_id en vez de deducirse de dónde
-- estaba en el lienzo. Se rellena una vez con la zona más pequeña que contenía
-- su centro; para una subsección, solo zonas más grandes que ella.
UPDATE `notes` SET `zone_id` = (
  SELECT z.`id` FROM `notes` z
  WHERE z.`kind` = 'zone'
    AND z.`deleted_at` IS NULL
    AND z.`profile_id` = `notes`.`profile_id`
    AND z.`id` != `notes`.`id`
    AND `notes`.`x` + COALESCE(`notes`.`w`, CASE WHEN `notes`.`kind` = 'zone' THEN 480 ELSE 240 END) / 2.0 BETWEEN z.`x` AND z.`x` + COALESCE(z.`w`, 480)
    AND `notes`.`y` + COALESCE(`notes`.`h`, CASE WHEN `notes`.`kind` = 'zone' THEN 320 ELSE 80 END) / 2.0 BETWEEN z.`y` AND z.`y` + COALESCE(z.`h`, 320)
    AND (`notes`.`kind` != 'zone' OR COALESCE(z.`w`, 480) * COALESCE(z.`h`, 320) > COALESCE(`notes`.`w`, 480) * COALESCE(`notes`.`h`, 320))
  ORDER BY COALESCE(z.`w`, 480) * COALESCE(z.`h`, 320)
  LIMIT 1
)
WHERE `zone_id` IS NULL AND `deleted_at` IS NULL;
--> statement-breakpoint
-- Sin lienzo libre, los fondos de puntos y cuadrícula no se ven: pasan a liso.
UPDATE `profiles` SET `background` = 'plain' WHERE `background` IN ('dots', 'grid');
