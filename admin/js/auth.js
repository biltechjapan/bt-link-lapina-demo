(function () {
  "use strict";

  /*
   * 公開できる Supabase URL と anon（publishable）キーだけを入れる。
   * service_role キーや秘密情報は入れない。
   * このリポジトリには既存の接続設定がなかったため、初期値は空。
   */
  var SUPABASE_URL = "https://imhfdvscwsaizqvnnztl.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_f9VbCQbX_nMvzEmL1U9oZw_proWYzIl";

  var client = null;

  function trim(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
  }

  function decodeJwtPayload(token) {
    var parts = String(token).split(".");
    if (parts.length < 2) return null;
    try {
      var body = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (body.length % 4) body += "=";
      return JSON.parse(atob(body));
    } catch (error) {
      return null;
    }
  }

  function isServiceRoleKey(key) {
    if (/sb_secret_/i.test(key)) return true;
    var payload = decodeJwtPayload(key);
    return !!(payload && payload.role === "service_role");
  }

  function configError() {
    var url = trim(SUPABASE_URL);
    var key = trim(SUPABASE_ANON_KEY);
    if (!url || !key) {
      return "Supabaseの公開接続設定がプロジェクト内に見つかりません。公開用URLとanonキーを設定してください。";
    }
    if (!/^https:\/\//i.test(url)) {
      return "SupabaseのURLはhttpsで始まる公開用URLを設定してください。";
    }
    if (isServiceRoleKey(key)) {
      return "service_roleキーは管理画面に設定できません。anonキーを設定してください。";
    }
    return "";
  }

  function getClient() {
    var problem = configError();
    if (problem) {
      var error = new Error(problem);
      error.code = "config";
      throw error;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      var libraryError = new Error("認証ライブラリを読み込めませんでした。");
      libraryError.code = "library";
      throw libraryError;
    }
    if (!client) {
      client = window.supabase.createClient(trim(SUPABASE_URL), trim(SUPABASE_ANON_KEY), {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
    }
    return client;
  }

  function authFailureMessage(error) {
    var status = error && error.status;
    var code = error && error.code ? String(error.code) : "";
    var raw = error && error.message ? String(error.message) : "";
    if (status === 429 || code === "over_request_rate_limit") {
      return "試行が集中しています。しばらくしてから再度お試しください。";
    }
    if (code === "invalid_credentials" || /invalid login credentials/i.test(raw)) {
      return "メールアドレスまたはパスワードが正しくありません。";
    }
    if (code === "email_not_confirmed") {
      return "メールアドレスの確認が完了していません。";
    }
    return "ログインできませんでした。入力内容をご確認ください。";
  }

  function permissionDenied() {
    return {
      ok: false,
      code: "forbidden",
      message: "このアカウントでは管理画面を利用できません。"
    };
  }

  function assertAdmin(supabaseClient, user) {
    if (!user || !user.id) return Promise.resolve(permissionDenied());
    return supabaseClient
      .from("profiles")
      .select("role, is_active")
      .eq("id", user.id)
      .maybeSingle()
      .then(function (result) {
        var profile = result.data;
        if (result.error || !profile || profile.role !== "admin" || profile.is_active !== true) {
          return permissionDenied();
        }
        return { ok: true, user: user };
      });
  }

  function signOut(supabaseClient) {
    var target = supabaseClient || client;
    if (!target) return Promise.resolve();
    return target.auth.signOut().then(function () {
      return undefined;
    }, function () {
      return undefined;
    });
  }

  function goToLogin(reason) {
    var url = "login.html";
    if (reason === "forbidden") url += "?denied=1";
    if (reason === "config") url += "?reason=config";
    window.location.replace(url);
  }

  function requireAdmin() {
    var problem = configError();
    if (problem) {
      goToLogin("config");
      return Promise.resolve(null);
    }
    var supabaseClient;
    try {
      supabaseClient = getClient();
    } catch (error) {
      goToLogin(error.code === "config" ? "config" : "");
      return Promise.resolve(null);
    }
    return supabaseClient.auth.getUser().then(function (result) {
      var user = result.data && result.data.user;
      if (result.error || !user) {
        goToLogin();
        return null;
      }
      return assertAdmin(supabaseClient, user).then(function (gate) {
        if (!gate.ok) {
          return signOut(supabaseClient).then(function () {
            goToLogin("forbidden");
            return null;
          });
        }
        return { user: user };
      });
    }).catch(function () {
      return signOut(supabaseClient).then(function () {
        goToLogin("forbidden");
        return null;
      });
    });
  }

  function showFormMessage(form, message) {
    var slot = form.querySelector("[data-auth-message]");
    if (!slot) return;
    slot.textContent = message || "";
  }

  function resumeAdminSession() {
    var supabaseClient;
    try {
      supabaseClient = getClient();
    } catch (error) {
      return;
    }
    supabaseClient.auth.getUser().then(function (result) {
      var user = result.data && result.data.user;
      if (result.error || !user) return null;
      return assertAdmin(supabaseClient, user).then(function (gate) {
        if (gate.ok) {
          window.location.replace("index.html");
          return null;
        }
        return signOut(supabaseClient);
      });
    }).catch(function () {
      return signOut(supabaseClient);
    });
  }

  function bindLoginForm() {
    var form = document.getElementById("login-form");
    if (!form) return;

    var params = new URLSearchParams(window.location.search);
    if (params.get("denied") === "1") {
      showFormMessage(form, "管理者権限を確認できないため、ダッシュボードを表示できません。");
    } else if (params.get("reason") === "config" || configError()) {
      showFormMessage(form, configError() || "接続設定を確認してください。");
    } else {
      resumeAdminSession();
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var emailInput = form.querySelector("#admin-email");
      var passwordInput = form.querySelector("#admin-password");
      var submitButton = form.querySelector("[type='submit']");
      var email = emailInput ? trim(emailInput.value) : "";
      var password = passwordInput ? passwordInput.value : "";
      var signedIn = false;
      if (!email || !password) {
        showFormMessage(form, "メールアドレスとパスワードを入力してください。");
        return;
      }

      if (submitButton) submitButton.disabled = true;
      form.setAttribute("aria-busy", "true");
      showFormMessage(form, "");

      var supabaseClient;
      try {
        supabaseClient = getClient();
      } catch (error) {
        showFormMessage(form, error.message);
        if (submitButton) submitButton.disabled = false;
        form.removeAttribute("aria-busy");
        return;
      }

      supabaseClient.auth.signInWithPassword({
        email: email,
        password: password
      }).then(function (result) {
        if (passwordInput) passwordInput.value = "";
        if (result.error || !result.data || !result.data.user) {
          showFormMessage(form, authFailureMessage(result.error));
          return null;
        }
        return assertAdmin(supabaseClient, result.data.user).then(function (gate) {
          if (!gate.ok) {
            return signOut(supabaseClient).then(function () {
              showFormMessage(form, gate.message);
            });
          }
          signedIn = true;
          window.location.replace("index.html");
        });
      }).catch(function () {
        showFormMessage(form, "ログインできませんでした。通信環境をご確認ください。");
        return signOut(supabaseClient);
      }).then(function () {
        if (signedIn) return;
        if (submitButton) submitButton.disabled = false;
        form.removeAttribute("aria-busy");
      });
    });
  }

  document.addEventListener("DOMContentLoaded", bindLoginForm);

  window.LapinaAuth = {
    configError: configError,
    requireAdmin: requireAdmin,
    getClient: function () {
      return getClient();
    },
    signOut: function () {
      var supabaseClient;
      try {
        supabaseClient = getClient();
      } catch (error) {
        window.location.replace("login.html");
        return Promise.resolve();
      }
      return signOut(supabaseClient).then(function () {
        window.location.replace("login.html");
      });
    }
  };
})();
