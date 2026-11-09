-- GitHub sign-in tokens were stored but never used after sign-in. Forget the ones already kept.
UPDATE `account` SET `access_token` = NULL, `refresh_token` = NULL, `id_token` = NULL, `access_token_expires_at` = NULL, `refresh_token_expires_at` = NULL WHERE `provider_id` <> 'credential';
