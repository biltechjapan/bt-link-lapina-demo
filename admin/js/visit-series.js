(function () {
  "use strict";

  /*
   * auth.js は変更しない。定期訪問の型と生成は RPC だけが書く。
   * 予約の手入力画面は、このファイルでは開かない。
   */
  var WEEKDAYS = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
  var STATUS = { active: "利用中", paused: "一時停止", ended: "終了", cancelled: "取消" };
  var TREATMENT = {
    massage: "マッサージ",
    acupuncture: "鍼",
    moxibustion: "灸",
    combined: "併用",
    other: "その他"
  };
  var PAYMENT = { insurance: "保険", private: "自費" };

  var patients = [];
  var locations = [];
  var seriesRows = [];
  var windows = [];
  var windowsReady = false;
  var pending = null;
  var busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value == null ? "" : value).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
  }

  function pageMessage(message) {
    var slot = $("page-message");
    if (slot) slot.textContent = message || "";
  }

  function formMessage(message) {
    var slot = $("form-message");
    if (slot) slot.textContent = message || "";
  }

  function confirmMessage(message) {
    var slot = $("confirm-message");
    if (slot) slot.textContent = message || "";
  }

  function getClient() {
    if (!window.LapinaAuth || typeof window.LapinaAuth.getClient !== "function") {
      throw new Error("認証ライブラリを読み込めませんでした。");
    }
    return window.LapinaAuth.getClient();
  }

  function clock(value) {
    var text = value ? String(value) : "";
    return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : "";
  }

  function minutesOf(value) {
    var matched = /^(\d{2}):(\d{2})$/.exec(clock(value));
    if (!matched) return null;
    var hour = Number(matched[1]);
    var minute = Number(matched[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function weekdayName(value) {
    return WEEKDAYS[Number(value)] || "曜日未設定";
  }

  function patientLabel(patient) {
    if (!patient) return "患者未設定";
    var name = trim((patient.last_name || "") + " " + (patient.first_name || ""));
    return trim((patient.patient_no || "") + " " + name) || "患者未設定";
  }

  function findPatient(id) {
    for (var i = 0; i < patients.length; i += 1) {
      if (patients[i].id === id) return patients[i];
    }
    return null;
  }

  function findLocation(id) {
    for (var i = 0; i < locations.length; i += 1) {
      if (locations[i].id === id) return locations[i];
    }
    return null;
  }

  function findSeries(id) {
    for (var i = 0; i < seriesRows.length; i += 1) {
      if (seriesRows[i].id === id) return seriesRows[i];
    }
    return null;
  }

  function errorText(error, fallback) {
    var raw = error && error.message ? String(error.message) : "";
    var known = [
      "この操作を行う権限がありません",
      "患者、訪問先、曜日、時刻、開始日、施術区分、支払区分を指定してください。",
      "曜日と時刻を確認してください。",
      "終了日は開始日以降にしてください。",
      "施術区分と支払区分を確認してください。",
      "患者が見つかりません。",
      "選択した患者の訪問先ではありません。",
      "定期訪問が見つかりません。",
      "利用中の定期訪問だけ、先の予約を作れます。",
      "利用中の定期訪問だけ一時停止できます。",
      "一時停止中の定期訪問だけ再開できます。",
      "終了済み、または取消済みの定期訪問です。",
      "終了日を指定してください。",
      "完了済みの予約は変更しません。"
    ];
    for (var i = 0; i < known.length; i += 1) {
      if (raw.indexOf(known[i]) !== -1) return known[i];
    }
    if (error && (error.code === "42501" || /permission denied|row-level security/i.test(raw))) {
      return "この操作を行う権限がありません。";
    }
    if (error && (error.code === "PGRST202" || /could not find the function/i.test(raw))) {
      return "定期訪問の機能がまだ有効ではありません。";
    }
    return fallback;
  }

  function setBusy(next) {
    busy = next;
    ["series-save", "confirm-run", "confirm-back"].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = next;
    });
    var actions = document.querySelectorAll(".series-action");
    for (var i = 0; i < actions.length; i += 1) actions[i].disabled = next || pending !== null;
  }

  function showSkips(rows) {
    var panel = $("skip-panel");
    var list = $("skip-list");
    var skipped = (rows || []).filter(function (row) {
      return row && row.outcome === "skipped" && row.occurrence_date;
    });
    list.innerHTML = "";
    panel.hidden = skipped.length === 0;
    skipped.forEach(function (row) {
      var item = document.createElement("li");
      item.textContent = row.occurrence_date + " " + (row.reason || "作れませんでした。");
      list.appendChild(item);
    });
  }

  function renderLocations(patientId) {
    var select = $("series-location");
    var current = select.value;
    select.innerHTML = "";
    var empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "選択してください";
    select.appendChild(empty);
    locations.forEach(function (location) {
      if (location.patient_id !== patientId) return;
      var option = document.createElement("option");
      option.value = location.id;
      option.textContent = location.location_name ? String(location.location_name) : "名称未設定";
      select.appendChild(option);
    });
    if (current) select.value = current;
  }

  function actionButton(label, action, id) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "button-quiet series-action";
    button.setAttribute("data-action", action);
    button.setAttribute("data-id", id);
    button.textContent = label;
    button.disabled = busy || pending !== null;
    return button;
  }

  function render() {
    var list = $("series-list");
    var empty = $("series-empty");
    list.innerHTML = "";
    empty.hidden = seriesRows.length > 0;
    seriesRows.forEach(function (row) {
      var item = document.createElement("article");
      item.className = "patient-item visit-item";
      var main = document.createElement("div");
      main.className = "patient-main";
      var title = document.createElement("div");
      title.className = "patient-name";
      title.textContent = patientLabel(findPatient(row.patient_id));
      var meta = document.createElement("div");
      meta.className = "patient-meta";
      var location = findLocation(row.location_id);
      meta.textContent = [
        weekdayName(row.weekday),
        clock(row.starts_at) + "–" + clock(row.ends_at),
        location && location.location_name ? location.location_name : "訪問先未設定",
        STATUS[row.status] || row.status,
        TREATMENT[row.treatment_type] || "",
        PAYMENT[row.payment_type] || ""
      ].join(" / ");
      var period = document.createElement("div");
      period.className = "patient-meta";
      period.textContent = row.starts_on + (row.ends_on ? " から " + row.ends_on + " まで" : " から、終了日なし");
      main.appendChild(title);
      main.appendChild(meta);
      main.appendChild(period);
      var actions = document.createElement("div");
      actions.className = "visit-actions";
      if (row.status === "active") {
        actions.appendChild(actionButton("先の12週間を作る", "extend", row.id));
        actions.appendChild(actionButton("一時停止", "pause", row.id));
        actions.appendChild(actionButton("終了", "end", row.id));
        actions.appendChild(actionButton("取消", "cancel", row.id));
      } else if (row.status === "paused") {
        actions.appendChild(actionButton("再開", "resume", row.id));
        actions.appendChild(actionButton("終了", "end", row.id));
        actions.appendChild(actionButton("取消", "cancel", row.id));
      }
      item.appendChild(main);
      if (actions.childNodes.length) item.appendChild(actions);
      list.appendChild(item);
    });
  }

  function loadAll() {
    var client = getClient();
    return Promise.all([
      client.from("patients").select("id, patient_no, last_name, first_name").order("patient_no", { ascending: true }),
      client.from("patient_locations").select("id, patient_id, location_name").order("location_name", { ascending: true }),
      client.from("visit_series").select("id, patient_id, location_id, weekday, starts_at, ends_at, starts_on, ends_on, treatment_type, payment_type, status").order("starts_on", { ascending: true })
    ]).then(function (results) {
      for (var i = 0; i < results.length; i += 1) {
        if (results[i].error) throw new Error(errorText(results[i].error, "定期訪問を読み込めませんでした。"));
      }
      patients = results[0].data || [];
      locations = results[1].data || [];
      seriesRows = results[2].data || [];
      return getClient().from("visit_availability_windows").select("weekday, starts_at, ends_at, is_active");
    }).then(function (result) {
      if (!result || result.error) {
        windows = [];
        windowsReady = false;
      } else {
        windows = result.data || [];
        windowsReady = true;
      }
      var select = $("series-patient");
      var current = select.value;
      select.innerHTML = "";
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "選択してください";
      select.appendChild(empty);
      patients.forEach(function (patient) {
        var option = document.createElement("option");
        option.value = patient.id;
        option.textContent = patientLabel(patient);
        select.appendChild(option);
      });
      if (current) select.value = current;
      renderLocations(select.value);
      render();
    });
  }

  function coveredByWindow(weekday, startText, endText) {
    var start = minutesOf(startText);
    var end = minutesOf(endText);
    if (start == null || end == null) return false;
    for (var i = 0; i < windows.length; i += 1) {
      var row = windows[i];
      if (Number(row.weekday) !== weekday || row.is_active !== true) continue;
      var rowStart = minutesOf(row.starts_at);
      var rowEnd = minutesOf(row.ends_at);
      if (rowStart == null || rowEnd == null) continue;
      if (rowStart <= start && rowEnd >= end) return true;
    }
    return false;
  }

  function payload() {
    var weekday = Number($("series-weekday").value);
    var start = clock($("series-start").value);
    var end = clock($("series-end").value);
    var startMinutes = minutesOf(start);
    var endMinutes = minutesOf(end);
    if (!$("series-patient").value) return { error: "患者を選択してください。" };
    if (!$("series-location").value) return { error: "訪問先を選択してください。" };
    if (startMinutes == null || endMinutes == null) return { error: "開始時刻と終了時刻を入力してください。" };
    if (endMinutes <= startMinutes) return { error: "終了時刻は開始時刻より後にしてください。" };
    if (!$("series-starts-on").value) return { error: "開始日を入力してください。" };
    if ($("series-ends-on").value && $("series-ends-on").value < $("series-starts-on").value) {
      return { error: "終了日は開始日以降にしてください。" };
    }
    if (!$("series-treatment").value || !$("series-payment").value) {
      return { error: "施術区分と支払区分を選択してください。" };
    }
    return {
      weekday: weekday,
      args: {
        p_patient_id: $("series-patient").value,
        p_location_id: $("series-location").value,
        p_weekday: weekday,
        p_starts_at: start,
        p_ends_at: end,
        p_starts_on: $("series-starts-on").value,
        p_ends_on: $("series-ends-on").value || null,
        p_treatment_type: $("series-treatment").value,
        p_payment_type: $("series-payment").value
      }
    };
  }

  function resultMessage(rows, createdLabel) {
    var created = 0;
    var skipped = 0;
    (rows || []).forEach(function (row) {
      if (!row) return;
      if (row.outcome === "created" || row.outcome === "resumed") created += 1;
      if (row.outcome === "skipped") skipped += 1;
    });
    if (skipped) {
      return createdLabel
        + (created ? created + " 日を登録しました。" : "")
        + "作れなかった " + skipped + " 日は、日付と理由を下に表示しています。";
    }
    if (created) return createdLabel + created + " 日を予約カレンダーへ登録しました。";
    return createdLabel + "新しく作る日はありませんでした。";
  }

  function saveForm(event) {
    event.preventDefault();
    if (busy || pending) return;
    var built = payload();
    if (built.error) {
      formMessage(built.error);
      return;
    }
    var needsWarning = !windowsReady || !coveredByWindow(built.weekday, built.args.p_starts_at, built.args.p_ends_at);
    var warning = windowsReady
      ? "訪問可能時間の外です。このまま登録しますか？"
      : "訪問可能時間を確認できません。このまま登録しますか？";
    if (needsWarning && !window.confirm(warning)) return;
    var samePatient = seriesRows.some(function (row) {
      return row.patient_id === built.args.p_patient_id && row.status === "active";
    });
    if (samePatient && !window.confirm("この患者には利用中の定期訪問があります。続きは一覧の「先の12週間を作る」を使います。別の曜日として新しく登録しますか？")) {
      return;
    }
    setBusy(true);
    formMessage("");
    pageMessage("");
    getClient().rpc("create_visit_series", built.args).then(function (result) {
      if (result.error) throw new Error(errorText(result.error, "定期訪問を登録できませんでした。"));
      showSkips(result.data || []);
      pageMessage(resultMessage(result.data, "定期訪問を登録しました。"));
      $("series-form").reset();
      $("series-weekday").value = "1";
      renderLocations("");
      return loadAll();
    }).catch(function (error) {
      formMessage(error && error.message ? error.message : "定期訪問を登録できませんでした。");
    }).then(function () {
      setBusy(false);
    });
  }

  function hideConfirm() {
    pending = null;
    confirmMessage("");
    $("confirm-text").textContent = "";
    $("confirm-date-field").hidden = true;
    $("confirm-panel").hidden = true;
    render();
  }

  function showConfirm(action, row) {
    pending = { action: action, id: row.id };
    $("confirm-date-field").hidden = action !== "end";
    $("confirm-date").value = row.ends_on || "";
    if (action === "pause") {
      $("confirm-title").textContent = "一時停止の確認";
      $("confirm-text").textContent = "これからの未変更の予約をキャンセルします。1回だけ変更・キャンセルした日と、完了済みは残します。";
      $("confirm-run").textContent = "一時停止する";
    } else if (action === "resume") {
      $("confirm-title").textContent = "再開の確認";
      $("confirm-text").textContent = "一時停止でキャンセルした日を、予約の重複を確認して戻します。1回だけのキャンセルは作り直しません。";
      $("confirm-run").textContent = "再開する";
    } else if (action === "extend") {
      $("confirm-title").textContent = "先の予約の確認";
      $("confirm-text").textContent = "今日から約12週間先まで、まだない日だけ作ります。登録済みの日と、1回だけ変更・キャンセルした日は作り直しません。終了日がある場合は、その日を超えません。";
      $("confirm-run").textContent = "先の12週間を作る";
    } else if (action === "end") {
      $("confirm-title").textContent = "終了の確認";
      $("confirm-text").textContent = "終了日より後の、未変更で未実施の予約をキャンセルします。完了済みは残します。";
      $("confirm-run").textContent = "終了する";
    } else {
      $("confirm-title").textContent = "取消の確認";
      $("confirm-text").textContent = "今日以降の、未変更で未実施の予約をキャンセルします。定期訪問自体も取消にします。完了済みは残します。";
      $("confirm-run").textContent = "取消する";
    }
    confirmMessage("");
    $("confirm-panel").hidden = false;
    render();
    $("confirm-run").focus();
  }

  function runConfirm() {
    if (busy || !pending) return;
    var action = pending.action;
    var id = pending.id;
    var args = { p_series_id: id };
    var name = "";
    if (action === "pause") name = "pause_visit_series";
    else if (action === "resume") name = "resume_visit_series";
    else if (action === "extend") name = "extend_visit_series";
    else if (action === "cancel") name = "cancel_visit_series";
    else if (action === "end") {
      if (!$("confirm-date").value) {
        confirmMessage("終了日を入力してください。");
        return;
      }
      name = "end_visit_series";
      args.p_ends_on = $("confirm-date").value;
    } else {
      return;
    }
    setBusy(true);
    confirmMessage("");
    getClient().rpc(name, args).then(function (result) {
      if (result.error) throw new Error(errorText(result.error, "定期訪問を更新できませんでした。"));
      showSkips(result.data || []);
      hideConfirm();
      pageMessage(action === "extend"
        ? resultMessage(result.data, "先の予約を確認しました。")
        : "定期訪問を更新しました。完了済みの予約は変更していません。");
      return loadAll();
    }).catch(function (error) {
      confirmMessage(error && error.message ? error.message : "定期訪問を更新できませんでした。");
      if (action === "extend") pageMessage(error && error.message ? error.message : "先の予約を作れませんでした。");
      setBusy(false);
    }).then(function () {
      setBusy(false);
    });
  }

  function onListClick(event) {
    var button = event.target.closest(".series-action");
    if (!button || busy || pending) return;
    var row = findSeries(button.getAttribute("data-id"));
    if (!row) return;
    var action = button.getAttribute("data-action");
    showConfirm(action, row);
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
  }

  function bindUi() {
    $("series-form").addEventListener("submit", saveForm);
    $("series-patient").addEventListener("change", function () {
      renderLocations($("series-patient").value);
    });
    $("series-list").addEventListener("click", onListClick);
    $("confirm-back").addEventListener("click", function () {
      if (busy) return;
      hideConfirm();
    });
    $("confirm-run").addEventListener("click", runConfirm);
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
      showApp(session.user);
      return loadAll().catch(function (error) {
        pageMessage(error && error.message ? error.message : "定期訪問を読み込めませんでした。");
      });
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "定期訪問を開けませんでした。");
    });
  });
})();
