-- A phone number must be a standalone token. Long alphanumeric model IDs may
-- contain the same digit sequence and remain valid product evidence.
CREATE OR REPLACE FUNCTION auto_listing_rich_policy_rules_valid(text_value TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT NOT (
    text_value ~* 'https?://'
    OR text_value ~* 'www\.'
    OR text_value ~* '[[:alnum:]_.%+-]+@[[:alnum:].-]+\.[A-Za-z]{2,}'
    OR text_value ~ '(^|[^[:alnum:]])(\+?7|8)[[:space:]()-]*[0-9]{3}[[:space:]()-]*[0-9]{3}[[:space:]-]*[0-9]{2}[[:space:]-]*[0-9]{2}($|[^[:alnum:]])'
    OR text_value ~* '(^|[^[:alnum:]])(telegram|whatsapp|viber|телеграм|ватсап|позвон|пишите|свяжитесь|контакт[[:alpha:]-]*|телефон[[:alpha:]-]*|обрат[[:alpha:]-]*[[:space:]]+к[[:space:]]+продавц[[:alpha:]-]*)'
    OR text_value ~* '(^|[^[:alnum:]])(остав(ьте|ить)[[:space:]]+отзыв|оцените[[:space:]]+(нас|товар)|отзыв)'
    OR text_value ~* '(^|[^[:alnum:]])(сертифицирован|сертификат|сертификац|лечебн|медицинск|исцел|гаранти|возврат|обмен)[[:alpha:]-]*'
    OR text_value ~* '(^|[^[:alnum:]])(подарок|бонус)'
  )
$$;
