/**
 * Auth.gs
 * ------------------------------------------------------------------
 * Google Identity Services が発行した ID トークン(JWT)を検証し、
 * 指定 Google グループのメンバーであることを確認する。
 *
 * 検証は Google の tokeninfo エンドポイントに委譲する。
 * （GAS 上で JWT 署名を自前検証するより確実で、鍵ローテーションにも追従する）
 * ------------------------------------------------------------------
 */

var TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

/**
 * ID トークンを検証してユーザー情報を返す。
 * @param {string} idToken
 * @return {{email: string, name: string, picture: string, sub: string}}
 */
function verifyIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new ApiError_('AUTH_REQUIRED', 'ID トークンが送信されていません。再ログインしてください。', 401);
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = 'tok:' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  );
  var cached = cache.get(cacheKey);
  if (cached) {
    lap_('token(cache)');
    return JSON.parse(cached);
  }

  // 計測専用の認証省略（PERF.md 1.5）。perfBypassUser_ はリポジトリに含めず、
  // 計測の間だけ GAS に置くファイルで定義する。そのファイルが無ければ何もしない。
  // ファイルを撤去した時点で失効させるため、結果はキャッシュしない（毎回ここで判定する）。
  if (typeof perfBypassUser_ === 'function') {
    var bypassUser = perfBypassUser_(idToken);
    if (bypassUser) {
      lap_('token(bypass)');
      return bypassUser;
    }
  }

  var res = UrlFetchApp.fetch(TOKENINFO_URL + encodeURIComponent(idToken), {
    method: 'get',
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new ApiError_('AUTH_INVALID_TOKEN', 'ID トークンが無効か期限切れです。再ログインしてください。', 401);
  }

  var payload;
  try {
    payload = JSON.parse(res.getContentText());
  } catch (e) {
    throw new ApiError_('AUTH_INVALID_TOKEN', 'ID トークンの解析に失敗しました。', 401);
  }

  // --- aud（このアプリ宛のトークンか） ---
  if (payload.aud !== cfgClientId_()) {
    throw new ApiError_('AUTH_AUD_MISMATCH', 'このアプリ向けのトークンではありません。', 401);
  }

  // --- iss ---
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new ApiError_('AUTH_ISS_MISMATCH', 'トークンの発行者が不正です。', 401);
  }

  // --- exp ---
  var exp = Number(payload.exp) * 1000;
  var remainMs = exp - Date.now();
  if (!exp || remainMs <= 0) {
    throw new ApiError_('AUTH_TOKEN_EXPIRED', 'ログインの有効期限が切れました。再ログインしてください。', 401);
  }

  // --- email ---
  if (!payload.email || String(payload.email_verified) !== 'true') {
    throw new ApiError_('AUTH_EMAIL_UNVERIFIED', 'メールアドレスが確認できませんでした。', 401);
  }

  var user = {
    email: String(payload.email).toLowerCase(),
    name: payload.name || payload.email,
    picture: payload.picture || '',
    sub: payload.sub || ''
  };

  // トークンの残存時間を超えてキャッシュしない
  var ttl = Math.min(CONST.TOKEN_CACHE_SEC, Math.floor(remainMs / 1000) - 10);
  if (ttl > 0) cache.put(cacheKey, JSON.stringify(user), ttl);
  lap_('token(fetch)');

  return user;
}

/**
 * 指定グループのメンバーかどうか。
 * GroupsApp はスクリプト実行者（＝デプロイしたアカウント）から見える
 * グループにしか照会できない点に注意。
 * @param {string} email
 * @return {boolean}
 */
function isGroupMember_(email) {
  var lower = String(email).toLowerCase();

  // 個別許可リスト（任意設定）
  if (cfgExtraAllowedEmails_().indexOf(lower) !== -1) {
    lap_('group(extra)');
    return true;
  }

  var cache = CacheService.getScriptCache();
  var key = 'grp:' + lower;
  var cached = cache.get(key);
  if (cached !== null) {
    lap_('group(cache)');
    return cached === '1';
  }

  var member = false;
  try {
    var group = GroupsApp.getGroupByEmail(cfgGroupEmail_());
    member = group.hasUser(lower);
  } catch (e) {
    // グループが見えない / 権限不足 は「不許可」ではなく設定エラーとして扱う。
    // 全員締め出しの原因になりやすいので、ログに残して明示的に落とす。
    console.error('GroupsApp lookup failed: ' + e.message);
    throw new ApiError_(
      'GROUP_LOOKUP_FAILED',
      'グループの照会に失敗しました（' + e.message + '）。ALLOWED_GROUP_EMAIL の設定と、' +
      'スクリプト実行アカウントがそのグループを参照できるかを確認してください。',
      500
    );
  }

  cache.put(key, member ? '1' : '0', CONST.GROUP_CACHE_SEC);
  lap_('group(lookup)');
  return member;
}

/**
 * 認証＋認可をまとめて行う。全ての保護された action の入口で呼ぶ。
 * @return {{email: string, name: string, picture: string}}
 */
function authenticate_(idToken) {
  var user = verifyIdToken_(idToken);
  if (!isGroupMember_(user.email)) {
    throw new ApiError_(
      'FORBIDDEN_NOT_MEMBER',
      'このアプリを利用する権限がありません（' + user.email + ' は許可グループのメンバーではありません）。',
      403
    );
  }
  return user;
}
