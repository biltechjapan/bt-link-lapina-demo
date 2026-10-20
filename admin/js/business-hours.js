(function () {
  "use strict";

  /*
   * auth.js は変更しない。公開URLと publishable キーで
   * ログイン済みセッションを共有する。RLSは回避しない。
   * service_role は使わない。
   *
   * 曜日設定は、例外日がない日の基準です。
   * 例外がある日は曜日より優先します。理由の公開設定は予約可否を変えません。
   * 判定の詳細は business-calendar.js の resolveBusinessDay にまとめています。
   * 祝日は計算しません。
   */
  var SETTINGS_COLUMNS = "id, slot_minutes, buffer_minutes";
  var WEEKDAY_COLUMNS = "weekday, is_open, opens_at, closes_at, last_reception";
  var WEEKDAYS = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];

  var busy = false;
  var settingsExists = false;
  var weekdayExists = [false, false, false, false, false, false, false];

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value == null ? "" : value).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
  }

  function pageMessage(message, ok) {
    var slot = $("page-message");
    if (!slot) return;
    slot.textContent = message || "";
    slot.classList.toggle("is-ok", !!ok && !!message);
  }

  function getClient() {
    if (!window.LapinaAuth || typeof window.LapinaAuth.getClient !== "function") {
      throw new Error("認証ライブラリを読み込めませんでした。");
    }
    return window.LapinaAuth.getClient();
  }

  function logSupabaseError(error, status) {
    if (!window.console || typeof console.error !== "function") return;
    console.error("Supabase error", {
      status: status != null ? status : (error && error.status != null ? error.status : null),
      code: error && error.code != null ? error.code : null,
      message: error && error.message != null ? error.message : null,
      hint: error && error.hint != null ? error.hint : null
    });
  }

  function fail(error, fallback, status) {
    logSupabaseError(error, status);
    throw new Error(errorText(error, fallback));
  }

  function withSession() {
    var supabaseClient;
    try {
      supabaseClient = getClient();
    } catch (error) {
      return Promise.reject(error);
    }
    return supabaseClient.auth.getSession().then(function (result) {
      var session = result && result.data ? result.data.session : null;
      if (!result || result.error || !session) {
        if (result && result.error) logSupabaseError(result.error);
        throw new Error("ログインセッションを確認できませんでした。再度ログインしてください。");
      }
      return supabaseClient;
    });
  }

  function errorText(error, fallback) {
    var code = error && error.code ? String(error.code) : "";
    var raw = error && error.message ? String(error.message) : "";
    var constraint = "";
    var matched = raw.match(/constraint "([^"]+)"/);
    if (matched) constraint = matched[1];
    if (code === "23514" || /check constraint/i.test(raw)) {
      if (constraint.indexOf("slot") !== -1) return "予約開始間隔は1〜60分で入力してください。";
      if (constraint.indexOf("buffer") !== -1) return "準備時間は0以上の整数で入力してください。";
      if (constraint.indexOf("time") !== -1) return "営業日は開店・閉店・最終受付が必要です。休業日は時刻を空にしてください。";
      return "入力内容が保存条件を満たしていません。";
    }
    if (code === "42501" || /permission denied|row-level security/i.test(raw)) {
      return "この操作を行う権限がありません。";
    }
    return fallback;
  }

  function parseInteger(value, label, min, max) {
    var text = trim(value).replace(/[０-９]/g, function (character) {
      return String.fromCharCode(character.charCodeAt(0) - 0xFEE0);
    }).replace(/[，,]/g, "");
    if (!text) return { error: label + "を入力してください。" };
    if (!/^\d+$/.test(text)) return { error: label + "は" + min + "以上の整数で入力してください。" };
    var number = Number(text);
    if (!isFinite(number) || number > 2147483647) return { error: label + "が大きすぎます。" };
    if (number < min) return { error: label + "は" + min + "以上の整数で入力してください。" };
    if (max != null && number > max) return { error: label + "は" + max + "以下で入力してください。" };
    return { value: number };
  }

  function clockInput(value) {
    var text = value ? String(value) : "";
    return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : "";
  }

  function minutesOf(value) {
    var matched = /^(\d{2}):(\d{2})$/.exec(trim(value));
    if (!matched) return null;
    var hour = Number(matched[1]);
    var minute = Number(matched[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function clockStorage(value) {
    var text = clockInput(value);
    return text ? text + ":00" : null;
  }

  function syncDay(weekday) {
    var isOpen = $("day-open-" + weekday).checked === true;
    $("day-opens-" + weekday).disabled = !isOpen;
    $("day-closes-" + weekday).disabled = !isOpen;
    $("day-last-" + weekday).disabled = !isOpen;
    var badge = $("day-state-" + weekday);
    badge.textContent = isOpen ? "営業" : "休業";
    badge.className = "business-badge " + (isOpen ? "is-open" : "is-closed");
  }

  function applyDay(weekday, row) {
    var isOpen = row ? row.is_open === true : false;
    $("day-open-" + weekday).checked = isOpen;
    $("day-opens-" + weekday).value = isOpen ? clockInput(row.opens_at) : "";
    $("day-closes-" + weekday).value = isOpen ? clockInput(row.closes_at) : "";
    $("day-last-" + weekday).value = isOpen ? clockInput(row.last_reception) : "";
    syncDay(weekday);
  }

  function applyMissingDay(weekday) {
    var isOpen = weekday !== 0;
    $("day-open-" + weekday).checked = isOpen;
    $("day-opens-" + weekday).value = isOpen ? "10:00" : "";
    $("day-closes-" + weekday).value = isOpen ? "21:00" : "";
    $("day-last-" + weekday).value = isOpen ? "18:30" : "";
    syncDay(weekday);
  }

  function readSettings() {
    var slot = parseInteger($("slot-minutes").value, "予約開始間隔", 1, 60);
    if (slot.error) return slot;
    var buffer = parseInteger($("buffer-minutes").value, "準備時間", 0, null);
    if (buffer.error) return buffer;
    return { value: { slot_minutes: slot.value, buffer_minutes: buffer.value } };
  }

  function readWeekdays() {
    var rows = [];
    for (var weekday = 0; weekday < 7; weekday += 1) {
      var name = WEEKDAYS[weekday];
      var isOpen = $("day-open-" + weekday).checked === true;
      if (!isOpen) {
        rows.push({
          weekday: weekday,
          exists: weekdayExists[weekday],
          is_open: false,
          opens_at: null,
          closes_at: null,
          last_reception: null
        });
        continue;
      }
      var opens = minutesOf($("day-opens-" + weekday).value);
      var closes = minutesOf($("day-closes-" + weekday).value);
      var last = minutesOf($("day-last-" + weekday).value);
      if (opens == null || closes == null || last == null) {
        return { error: name + "は、開店・閉店・最終受付を入力してください。" };
      }
      if (!(opens < closes)) {
        return { error: name + "は、開店時刻を閉店時刻より前にしてください。" };
      }
      if (last < opens || last > closes) {
        return { error: name + "は、最終受付を開店から閉店までの時刻にしてください。" };
      }
      rows.push({
        weekday: weekday,
        exists: weekdayExists[weekday],
        is_open: true,
        opens_at: clockStorage($("day-opens-" + weekday).value),
        closes_at: clockStorage($("day-closes-" + weekday).value),
        last_reception: clockStorage($("day-last-" + weekday).value)
      });
    }
    return { value: rows };
  }

  function setBusy(next) {
    busy = next;
    $("hours-save").disabled = next;
    $("hours-reload").disabled = next;
  }

  function loadAll() {
    return withSession().then(function (supabaseClient) {
      return supabaseClient
      .from("business_settings")
      .select(SETTINGS_COLUMNS)
      .maybeSingle()
      .then(function (settingsResult) {
        if (settingsResult.error) fail(settingsResult.error, "予約間隔を読み込めませんでした。", settingsResult.status);
        var settings = settingsResult.data;
        settingsExists = !!settings;
        $("slot-minutes").value = settings ? String(settings.slot_minutes) : "15";
        $("buffer-minutes").value = settings ? String(settings.buffer_minutes) : "0";
        return supabaseClient
          .from("business_weekday_hours")
          .select(WEEKDAY_COLUMNS)
          .order("weekday", { ascending: true });
      })
      .then(function (dayResult) {
        if (dayResult.error) fail(dayResult.error, "曜日ごとの営業時間を読み込めませんでした。", dayResult.status);
        var rows = dayResult.data || [];
        var byWeekday = {};
        rows.forEach(function (row) {
          byWeekday[row.weekday] = row;
        });
        var missing = 0;
        for (var weekday = 0; weekday < 7; weekday += 1) {
          weekdayExists[weekday] = !!byWeekday[weekday];
          if (byWeekday[weekday]) applyDay(weekday, byWeekday[weekday]);
          else {
            missing += 1;
            applyMissingDay(weekday);
          }
        }
        return { settingsExists: settingsExists, missing: missing, count: rows.length };
      });
    });
  }

  function saveSettings(supabaseClient, payload) {
    var request;
    if (settingsExists) {
      request = supabaseClient
        .from("business_settings")
        .update(payload)
        .eq("id", true)
        .select("id")
        .maybeSingle();
    } else {
      payload.id = true;
      request = supabaseClient
        .from("business_settings")
        .insert(payload)
        .select("id")
        .single();
    }
    return request.then(function (result) {
      if (result.error) fail(result.error, "予約間隔を保存できませんでした。", result.status);
      if (!result.data) throw new Error("予約間隔を保存できませんでした。再読み込みして再度お試しください。");
    });
  }

  function saveWeekdays(supabaseClient, rows) {
    var index = 0;
    function next() {
      if (index >= rows.length) return Promise.resolve();
      var row = rows[index];
      index += 1;
      var payload = {
        is_open: row.is_open,
        opens_at: row.opens_at,
        closes_at: row.closes_at,
        last_reception: row.last_reception
      };
      var request;
      if (row.exists) {
        request = supabaseClient
          .from("business_weekday_hours")
          .update(payload)
          .eq("weekday", row.weekday)
          .select("weekday")
          .maybeSingle();
      } else {
        payload.weekday = row.weekday;
        request = supabaseClient
          .from("business_weekday_hours")
          .insert(payload)
          .select("weekday")
          .single();
      }
      return request.then(function (result) {
        if (result.error) fail(result.error, WEEKDAYS[row.weekday] + "を保存できませんでした。", result.status);
        if (!result.data) {
          throw new Error(WEEKDAYS[row.weekday] + "を保存できませんでした。再読み込みして再度お試しください。");
        }
        return next();
      });
    }
    return next();
  }

  function saveForm(event) {
    event.preventDefault();
    if (busy) return;
    pageMessage("");
    var settings = readSettings();
    if (settings.error) {
      pageMessage(settings.error, false);
      return;
    }
    var days = readWeekdays();
    if (days.error) {
      pageMessage(days.error, false);
      return;
    }
    setBusy(true);
    withSession().then(function (supabaseClient) {
      return saveSettings(supabaseClient, settings.value).then(function () {
        return saveWeekdays(supabaseClient, days.value);
      });
    }).then(function () {
      return loadAll();
    }).then(function () {
      pageMessage("保存しました。", true);
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "保存できませんでした。", false);
      return loadAll().catch(function () {
        return null;
      });
    }).then(function () {
      setBusy(false);
    });
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
  }

  function bindUi() {
    for (var weekday = 0; weekday < 7; weekday += 1) {
      (function (day) {
        $("day-open-" + day).addEventListener("change", function () {
          var isOpen = $("day-open-" + day).checked === true;
          if (isOpen) {
            if (!$("day-opens-" + day).value) $("day-opens-" + day).value = "10:00";
            if (!$("day-closes-" + day).value) $("day-closes-" + day).value = "21:00";
            if (!$("day-last-" + day).value) $("day-last-" + day).value = "18:30";
          } else {
            $("day-opens-" + day).value = "";
            $("day-closes-" + day).value = "";
            $("day-last-" + day).value = "";
          }
          syncDay(day);
        });
        syncDay(day);
      })(weekday);
    }
    $("hours-form").addEventListener("submit", saveForm);
    $("hours-reload").addEventListener("click", function () {
      if (busy) return;
      pageMessage("");
      setBusy(true);
      loadAll().then(function () {
        pageMessage("再読み込みしました。", true);
      }).catch(function (error) {
        pageMessage(error && error.message ? error.message : "再読み込みできませんでした。", false);
      }).then(function () {
        setBusy(false);
      });
    });
    var logout = $("logout-button");
    if (logout && window.LapinaAuth) {
      logout.addEventListener("click", function () {
        logout.disabled = true;
        window.LapinaAuth.signOut();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindUi();
    if (!window.LapinaAuth) return;
    window.LapinaAuth.requireAdmin().then(function (session) {
      if (!session) return;
      try {
        getClient();
      } catch (error) {
        pageMessage(error.message, false);
        return null;
      }
      showApp(session.user);
      return loadAll().then(function (state) {
        if (!state.settingsExists && state.count === 0) {
          pageMessage("営業時間は未登録です。内容を確認して保存すると登録されます。", false);
        } else if (state.missing > 0) {
          pageMessage("一部の曜日が未登録です。保存すると不足分も登録されます。", false);
        }
      }).catch(function (error) {
        pageMessage(error && error.message ? error.message : "営業時間を読み込めませんでした。", false);
      });
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "営業時間を開けませんでした。", false);
    });
  });
})();
