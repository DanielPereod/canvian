-- Ya no hay zonas: todo son notas y cualquiera puede ser madre de otras
-- (zone_id pasa a ser la nota madre). Cada zona se vuelve una nota cuyo texto
-- es su nombre, en negrita como primera línea; lo que contenía sigue dentro.
UPDATE `notes` SET
  `kind` = 'text',
  `body_json` = COALESCE(`body_json`, json_object('type', 'doc', 'content', json_array(json_object(
    'type', 'paragraph',
    'content', CASE WHEN COALESCE(`title`, '') = '' THEN json_array()
      ELSE json_array(json_object('type', 'text', 'marks', json_array(json_object('type', 'bold')), 'text', `title`)) END
  )))),
  `body_text` = COALESCE(`body_text`, `title`)
WHERE `kind` = 'zone';
