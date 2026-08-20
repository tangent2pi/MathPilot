-- 0023: 修复旧恢复链中已持久化题图的通用二进制 MIME。
-- 只依据不可变字节的标准文件魔数识别；不改写图片、hash、bbox 或来源。
begin;

update content_question_asset
   set mime_type = case
     when substring(image_bytes from 1 for 3) = decode('ffd8ff','hex') then 'image/jpeg'
     when substring(image_bytes from 1 for 8) = decode('89504e470d0a1a0a','hex') then 'image/png'
     when substring(image_bytes from 1 for 6) in (convert_to('GIF87a','UTF8'),convert_to('GIF89a','UTF8')) then 'image/gif'
     when substring(image_bytes from 1 for 4) = convert_to('RIFF','UTF8')
      and substring(image_bytes from 9 for 4) = convert_to('WEBP','UTF8') then 'image/webp'
     else mime_type
   end
 where mime_type = 'application/octet-stream';

update content_question q
   set payload = jsonb_set(q.payload,'{assets}',(
     select jsonb_agg(
       case when a.asset_id is null then item
            else jsonb_set(item,'{mime_type}',to_jsonb(a.mime_type),true)
       end order by ord
     )
       from jsonb_array_elements(coalesce(q.payload->'assets','[]'::jsonb)) with ordinality as x(item,ord)
       left join content_question_asset a
         on a.tenant_id=q.tenant_id and a.asset_id=x.item->>'asset_id'
   ),true)
 where jsonb_typeof(q.payload->'assets')='array'
   and jsonb_array_length(q.payload->'assets')>0;

insert into infra_schema_migration(version) values ('0023_question_asset_mime');
commit;
