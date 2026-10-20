(function () {
  "use strict";

  /*
   * auth.js は変更しない。公開URLと publishable キーで
   * ログイン済みセッションを共有する。RLSは回避しない。
   * service_role は使わない。公開用RPCは使わない。
   * 管理者メモは、この管理画面のテーブル参照だけで扱う。
   * 祝日の日付は計算して追加しない。内閣府CSVにある行だけを登録する。
   * CSVの文字コード、日付、区分、重複、競合の確認はこの画面で行う。
   * 登録と一括削除は、SQL適用と管理者権限の確認が終わるまで実行しない。
   */
  var WEEKDAY_COLUMNS = "weekday, is_open, opens_at, closes_at, last_reception";
  var EXCEPTION_COLUMNS = "id, exception_date, kind, public_reason, admin_note, is_customer_visible, opens_at, closes_at, last_reception";
  var KIND = {
    holiday: "祝日",
    substitute_holiday: "振替休日",
    temporary_closure: "臨時休業",
    special_open: "特別営業"
  };
  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
  var CLOSED_KINDS = { holiday: true, substitute_holiday: true, temporary_closure: true };

  var HOLIDAY_HEADER_DATE = "国民の祝日・休日月日";
  var HOLIDAY_HEADER_NAME = "国民の祝日・休日名称";
  var HOLIDAY_SPAN = 5;
  var HOLIDAY_BASE_DEFAULT = 2026;
  /*
   * 本番SQLの適用と、管理者権限およびRPCの確認が終わるまで false。
   * 画面から true にはしない。
   */
  var HOLIDAY_DB_CONFIRMED = false;

  var busy = false;
  var exceptions = [];
  var weekdayRows = {};
  var viewYear = 2026;
  var viewMonth = 10;
  var holidayState = {
    ready: false,
    text: "",
    encoding: "",
    years: [],
    insertCount: 0
  };

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

  function formMessage(message) {
    var slot = $("form-message");
    if (slot) slot.textContent = message || "";
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

  /*
   * 予約枠の優先順位。将来の空き枠計算は、この関数の結果だけを使う。
   *
   * 1. その日付に例外が1件ある場合、曜日設定より優先する。同一日付は1件だけ。
   *    - special_open: 営業。時刻は例外の開店・閉店・最終受付。
   *    - holiday / substitute_holiday / temporary_closure: 休業。
   * 2. 例外がない日は、曜日の is_open と時刻を使う。
   *
   * is_customer_visible は、公開理由をお客様に見せるかだけを決める。
   * 非表示でも、祝日・振替休日・臨時休業は予約枠では休業。
   * 特別営業は、理由を非公開でも営業。
   * 祝日の日付をこの関数で作らない。
   */
  function resolveBusinessDay(weekdayRow, exceptionRow) {
    if (exceptionRow) {
      if (exceptionRow.kind === "special_open") {
        return {
          bookable: true,
          source: "special_open",
          opens_at: exceptionRow.opens_at,
          closes_at: exceptionRow.closes_at,
          last_reception: exceptionRow.last_reception
        };
      }
      if (CLOSED_KINDS[exceptionRow.kind]) {
        return {
          bookable: false,
          source: exceptionRow.kind,
          opens_at: null,
          closes_at: null,
          last_reception: null
        };
      }
      return {
        bookable: false,
        source: "unknown",
        opens_at: null,
        closes_at: null,
        last_reception: null
      };
    }
    if (!weekdayRow || weekdayRow.is_open !== true) {
      return {
        bookable: false,
        source: "weekday",
        opens_at: null,
        closes_at: null,
        last_reception: null
      };
    }
    return {
      bookable: true,
      source: "weekday",
      opens_at: weekdayRow.opens_at,
      closes_at: weekdayRow.closes_at,
      last_reception: weekdayRow.last_reception
    };
  }

  function errorText(error, fallback) {
    var code = error && error.code ? String(error.code) : "";
    var raw = error && error.message ? String(error.message) : "";
    var constraint = "";
    var matched = raw.match(/constraint "([^"]+)"/);
    if (matched) constraint = matched[1];
    if (code === "23505" || /duplicate key/i.test(raw)) {
      return "この日付は既に登録されています。同じ日付は1件だけ登録できます。";
    }
    if (code === "23514" || /check constraint/i.test(raw)) {
      if (constraint.indexOf("hours") !== -1) {
        return "特別営業は開店・閉店・最終受付が必要です。それ以外は時刻を空にしてください。";
      }
      if (constraint.indexOf("kind") !== -1) return "区分を選択してください。";
      return "入力内容が保存条件を満たしていません。";
    }
    if (code === "42501" || /permission denied|row-level security/i.test(raw)) {
      return "この操作を行う権限がありません。";
    }
    return fallback;
  }

  function clockInput(value) {
    var text = value ? String(value) : "";
    return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : "";
  }

  function clockStorage(value) {
    var text = clockInput(value);
    return text ? text + ":00" : null;
  }

  function minutesOf(value) {
    var matched = /^(\d{2}):(\d{2})$/.exec(trim(value));
    if (!matched) return null;
    var hour = Number(matched[1]);
    var minute = Number(matched[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function dateKey(value) {
    var text = value ? String(value) : "";
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
  }

  function weekdayOfDate(isoDate) {
    var parts = isoDate.split("-");
    var utc = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    return utc.getUTCDay();
  }

  function japanTodayParts() {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    var map = {};
    parts.forEach(function (part) {
      map[part.type] = part.value;
    });
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day)
    };
  }

  function selectedId() {
    return $("closure-form").getAttribute("data-id") || "";
  }

  function findException(id) {
    for (var i = 0; i < exceptions.length; i += 1) {
      if (exceptions[i].id === id) return exceptions[i];
    }
    return null;
  }

  function findByDate(isoDate, currentId) {
    for (var i = 0; i < exceptions.length; i += 1) {
      if (exceptions[i].id !== currentId && dateKey(exceptions[i].exception_date) === isoDate) {
        return exceptions[i];
      }
    }
    return null;
  }

  function exceptionOn(isoDate) {
    for (var i = 0; i < exceptions.length; i += 1) {
      if (dateKey(exceptions[i].exception_date) === isoDate) return exceptions[i];
    }
    return null;
  }

  function hasOfficialHoliday() {
    for (var i = 0; i < exceptions.length; i += 1) {
      if (exceptions[i].kind === "holiday" || exceptions[i].kind === "substitute_holiday") return true;
    }
    return false;
  }

  function kindLabel(kind) {
    return Object.prototype.hasOwnProperty.call(KIND, kind) ? KIND[kind] : kind || "";
  }

  function slotText(row) {
    var decision = resolveBusinessDay(weekdayRows[weekdayOfDate(dateKey(row.exception_date))], row);
    var hours = "";
    if (decision.bookable && decision.opens_at) {
      hours = " " + clockInput(decision.opens_at) + "–" + clockInput(decision.closes_at);
    }
    if (decision.bookable) {
      return (row.is_customer_visible === true ? "営業" : "営業（理由は非公開）") + hours;
    }
    return row.is_customer_visible === true ? "休業" : "休業（理由は非公開）";
  }

  function setBusy(next) {
    busy = next;
    ["closure-save", "closure-reset", "closure-reload", "closure-delete", "cal-prev", "cal-next", "holiday-preview", "holiday-delete-preview"].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = next;
    });
    ["holiday-file", "holiday-base-year", "holiday-delete-year"].forEach(function (id) {
      var field = $(id);
      if (field) field.disabled = next;
    });
    var yearChecks = document.querySelectorAll(".holiday-year-check");
    for (var checkIndex = 0; checkIndex < yearChecks.length; checkIndex += 1) {
      yearChecks[checkIndex].disabled = next;
    }
    syncHolidayWriteButtons();
    if (!next) {
      render();
      return;
    }
    var buttons = document.querySelectorAll(".closure-row-action");
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
  }

  function badge(text, className) {
    var mark = document.createElement("span");
    mark.className = "business-badge " + className;
    mark.textContent = text;
    return mark;
  }

  function kindBadge(kind) {
    if (kind === "special_open") return badge(kindLabel(kind), "is-open");
    return badge(kindLabel(kind), "is-closed");
  }

  function slotBadge(row) {
    var decision = resolveBusinessDay(weekdayRows[weekdayOfDate(dateKey(row.exception_date))], row);
    return badge(slotText(row), decision.bookable ? "is-open" : "is-closed");
  }

  function visibleBadge(row) {
    return row.is_customer_visible === true
      ? badge("理由を表示", "is-visible")
      : badge("理由を非表示", "is-hidden");
  }

  function actionGroup(row) {
    var group = document.createElement("div");
    group.className = "closure-actions";
    var edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button-quiet closure-row-action";
    edit.setAttribute("data-action", "edit");
    edit.setAttribute("data-id", row.id);
    edit.textContent = "編集";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button-quiet closure-row-action closure-delete";
    remove.setAttribute("data-action", "delete");
    remove.setAttribute("data-id", row.id);
    remove.textContent = "削除";
    group.appendChild(edit);
    group.appendChild(remove);
    return group;
  }

  function dateLabel(row) {
    var iso = dateKey(row.exception_date);
    return iso + "（" + WEEKDAYS[weekdayOfDate(iso)] + "）";
  }

  function reasonText(row) {
    var parts = [];
    if (row.public_reason) parts.push(String(row.public_reason));
    if (row.admin_note) parts.push("メモ: " + String(row.admin_note));
    return parts.join(" / ");
  }

  function renderList() {
    var table = $("closure-table");
    var cards = $("closure-cards");
    var empty = $("closure-empty");
    var tableWrap = document.querySelector(".closure-table-wrap");
    var currentId = selectedId();
    table.innerHTML = "";
    cards.innerHTML = "";
    empty.hidden = exceptions.length > 0;
    if (tableWrap) tableWrap.hidden = exceptions.length === 0;
    cards.hidden = exceptions.length === 0;

    exceptions.forEach(function (row) {
      var tr = document.createElement("tr");
      if (row.id === currentId) tr.className = "is-selected";
      var dateCell = document.createElement("td");
      dateCell.textContent = dateLabel(row);
      tr.appendChild(dateCell);
      var kindCell = document.createElement("td");
      kindCell.appendChild(kindBadge(row.kind));
      tr.appendChild(kindCell);
      var slotCell = document.createElement("td");
      slotCell.appendChild(slotBadge(row));
      tr.appendChild(slotCell);
      var reasonCell = document.createElement("td");
      reasonCell.className = "closure-reason";
      var reason = document.createElement("div");
      reason.textContent = row.public_reason ? String(row.public_reason) : "公開理由なし";
      reasonCell.appendChild(reason);
      reasonCell.appendChild(visibleBadge(row));
      if (row.admin_note) {
        var note = document.createElement("div");
        note.className = "closure-note";
        note.textContent = "管理者メモ: " + String(row.admin_note);
        reasonCell.appendChild(note);
      }
      tr.appendChild(reasonCell);
      var actionCell = document.createElement("td");
      actionCell.appendChild(actionGroup(row));
      tr.appendChild(actionCell);
      table.appendChild(tr);

      var card = document.createElement("article");
      card.className = "patient-item closure-card" + (row.id === currentId ? " is-selected" : "");
      var main = document.createElement("div");
      main.className = "patient-main";
      var title = document.createElement("div");
      title.className = "patient-name";
      title.textContent = dateLabel(row);
      var meta = document.createElement("div");
      meta.className = "patient-meta";
      meta.textContent = reasonText(row) || "公開理由なし";
      var marks = document.createElement("div");
      marks.className = "closure-marks";
      marks.appendChild(kindBadge(row.kind));
      marks.appendChild(slotBadge(row));
      marks.appendChild(visibleBadge(row));
      main.appendChild(title);
      main.appendChild(marks);
      main.appendChild(meta);
      card.appendChild(main);
      card.appendChild(actionGroup(row));
      cards.appendChild(card);
    });
  }

  function renderCalendar() {
    var grid = $("cal-grid");
    var title = $("cal-title");
    title.textContent = viewYear + "年" + viewMonth + "月";
    grid.innerHTML = "";
    WEEKDAYS.forEach(function (label, index) {
      var head = document.createElement("div");
      head.className = "closure-cal-weekday";
      head.textContent = label;
      if (index === 0) head.className += " is-sun";
      if (index === 6) head.className += " is-sat";
      grid.appendChild(head);
    });
    var first = new Date(Date.UTC(viewYear, viewMonth - 1, 1));
    var pad = first.getUTCDay();
    var days = new Date(Date.UTC(viewYear, viewMonth, 0)).getUTCDate();
    var today = japanTodayParts();
    var selected = dateKey($("exception-date").value);
    for (var blank = 0; blank < pad; blank += 1) {
      var empty = document.createElement("div");
      empty.className = "closure-day is-blank";
      grid.appendChild(empty);
    }
    for (var day = 1; day <= days; day += 1) {
      var iso = viewYear + "-" + (viewMonth < 10 ? "0" : "") + viewMonth + "-" + (day < 10 ? "0" : "") + day;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "closure-day";
      button.setAttribute("data-date", iso);
      if (iso === selected) button.className += " is-selected";
      if (today.year === viewYear && today.month === viewMonth && today.day === day) {
        button.className += " is-today";
      }
      var number = document.createElement("span");
      number.className = "closure-day-num";
      number.textContent = String(day);
      button.appendChild(number);
      var row = exceptionOn(iso);
      var weekday = weekdayOfDate(iso);
      var decision = resolveBusinessDay(weekdayRows[weekday], row);
      if (row || (weekdayRows[weekday] && decision.bookable !== true)) {
        var mark = document.createElement("span");
        mark.className = "closure-day-mark " + (decision.bookable ? "is-open" : "is-closed");
        mark.textContent = row ? kindLabel(row.kind) : "休業";
        button.appendChild(mark);
      }
      grid.appendChild(button);
    }
  }

  function render() {
    $("holiday-missing").hidden = hasOfficialHoliday();
    renderCalendar();
    renderList();
    if (!busy) return;
    var buttons = document.querySelectorAll(".closure-row-action");
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
  }

  function syncKind() {
    var special = $("exception-kind").value === "special_open";
    $("special-hours").hidden = !special;
    $("special-opens").disabled = !special;
    $("special-closes").disabled = !special;
    $("special-last").disabled = !special;
    if (!special) {
      $("special-opens").value = "";
      $("special-closes").value = "";
      $("special-last").value = "";
    }
  }

  function resetForm(keepDate) {
    var date = keepDate ? dateKey($("exception-date").value) : "";
    var form = $("closure-form");
    form.removeAttribute("data-id");
    form.reset();
    $("exception-date").value = date;
    $("customer-visible").checked = false;
    $("closure-delete").hidden = true;
    $("form-title").textContent = "休業日の登録";
    formMessage("");
    syncKind();
    render();
  }

  function fillForm(row) {
    $("closure-form").setAttribute("data-id", row.id);
    $("exception-date").value = dateKey(row.exception_date);
    $("exception-kind").value = Object.prototype.hasOwnProperty.call(KIND, row.kind) ? row.kind : "";
    $("public-reason").value = row.public_reason ? String(row.public_reason) : "";
    $("admin-note").value = row.admin_note ? String(row.admin_note) : "";
    $("customer-visible").checked = row.is_customer_visible === true;
    $("special-opens").value = clockInput(row.opens_at);
    $("special-closes").value = clockInput(row.closes_at);
    $("special-last").value = clockInput(row.last_reception);
    $("closure-delete").hidden = false;
    $("form-title").textContent = "休業日の編集";
    formMessage("");
    syncKind();
    if (row.kind === "special_open") {
      $("special-opens").value = clockInput(row.opens_at);
      $("special-closes").value = clockInput(row.closes_at);
      $("special-last").value = clockInput(row.last_reception);
    }
    var iso = dateKey(row.exception_date);
    if (iso) {
      viewYear = Number(iso.slice(0, 4));
      viewMonth = Number(iso.slice(5, 7));
    }
    render();
  }

  function readForm() {
    var currentId = selectedId();
    var iso = dateKey($("exception-date").value);
    if (!iso) return { error: "日付を入力してください。" };
    var kind = $("exception-kind").value;
    if (!Object.prototype.hasOwnProperty.call(KIND, kind)) return { error: "区分を選択してください。" };
    var reason = trim($("public-reason").value);
    if (reason.length > 200) return { error: "公開理由は200文字以内で入力してください。" };
    var note = trim($("admin-note").value);
    if (note.length > 2000) return { error: "管理者メモは2000文字以内で入力してください。" };
    if (findByDate(iso, currentId)) return { error: "この日付は既に登録されています。同じ日付は1件だけ登録できます。" };
    var opens = null;
    var closes = null;
    var last = null;
    if (kind === "special_open") {
      var openMinutes = minutesOf($("special-opens").value);
      var closeMinutes = minutesOf($("special-closes").value);
      var lastMinutes = minutesOf($("special-last").value);
      if (openMinutes == null || closeMinutes == null || lastMinutes == null) {
        return { error: "特別営業は、開店・閉店・最終受付を入力してください。" };
      }
      if (!(openMinutes < closeMinutes)) return { error: "開店時刻は閉店時刻より前にしてください。" };
      if (lastMinutes < openMinutes || lastMinutes > closeMinutes) {
        return { error: "最終受付は開店から閉店までの時刻にしてください。" };
      }
      opens = clockStorage($("special-opens").value);
      closes = clockStorage($("special-closes").value);
      last = clockStorage($("special-last").value);
    }
    return {
      value: {
        exception_date: iso,
        kind: kind,
        public_reason: reason ? reason : null,
        admin_note: note ? note : null,
        is_customer_visible: $("customer-visible").checked === true,
        opens_at: opens,
        closes_at: closes,
        last_reception: last
      }
    };
  }

  function loadAll() {
    return withSession().then(function (supabaseClient) {
      return supabaseClient
        .from("business_weekday_hours")
        .select(WEEKDAY_COLUMNS)
        .order("weekday", { ascending: true })
        .then(function (dayResult) {
          if (dayResult.error) fail(dayResult.error, "曜日ごとの営業時間を読み込めませんでした。", dayResult.status);
          weekdayRows = {};
          (dayResult.data || []).forEach(function (row) {
            weekdayRows[row.weekday] = row;
          });
          return supabaseClient
            .from("business_calendar_exceptions")
            .select(EXCEPTION_COLUMNS)
            .order("exception_date", { ascending: true });
        })
        .then(function (result) {
          if (result.error) fail(result.error, "休業日を読み込めませんでした。", result.status);
          exceptions = result.data || [];
          render();
        });
    });
  }

  function saveForm(event) {
    event.preventDefault();
    if (busy) return;
    pageMessage("");
    formMessage("");
    var built = readForm();
    if (built.error) {
      formMessage(built.error);
      return;
    }
    var currentId = selectedId();
    setBusy(true);
    withSession().then(function (supabaseClient) {
      var request;
      if (!currentId) {
        request = supabaseClient
          .from("business_calendar_exceptions")
          .insert(built.value)
          .select("id")
          .single();
      } else {
        request = supabaseClient
          .from("business_calendar_exceptions")
          .update(built.value)
          .eq("id", currentId)
          .select("id")
          .maybeSingle();
      }
      return request;
    }).then(function (result) {
      if (result.error) fail(result.error, "休業日を保存できませんでした。", result.status);
      if (!result.data) throw new Error("休業日を保存できませんでした。再読み込みして再度お試しください。");
      var savedId = result.data.id;
      return loadAll().then(function () {
        var saved = findException(savedId);
        if (saved) fillForm(saved);
        pageMessage("保存しました。", true);
      });
    }).catch(function (error) {
      formMessage(error && error.message ? error.message : "休業日を保存できませんでした。");
      return loadAll();
    }).then(function () {
      setBusy(false);
    });
  }

  function removeException(row) {
    if (busy || !row) return;
    var agreed = window.confirm(dateLabel(row) + "の" + kindLabel(row.kind) + "を削除しますか？この操作は取り消せません。");
    if (!agreed) return;
    pageMessage("");
    formMessage("");
    setBusy(true);
    withSession().then(function (supabaseClient) {
      return supabaseClient
        .from("business_calendar_exceptions")
        .delete()
        .eq("id", row.id)
        .select("id");
    }).then(function (result) {
        if (result.error) fail(result.error, "休業日を削除できませんでした。", result.status);
        if (!result.data || !result.data.length) {
          throw new Error("休業日を削除できませんでした。再読み込みして再度お試しください。");
        }
        if (selectedId() === row.id) resetForm("");
        return loadAll().then(function () {
          pageMessage("削除しました。", true);
        });
      })
      .catch(function (error) {
        pageMessage(error && error.message ? error.message : "休業日を削除できませんでした。", false);
        return loadAll();
      })
      .then(function () {
        setBusy(false);
      });
  }

  function chooseDate(iso) {
    var row = exceptionOn(iso);
    pageMessage("");
    if (row) {
      fillForm(row);
      return;
    }
    resetForm("");
    $("exception-date").value = iso;
    viewYear = Number(iso.slice(0, 4));
    viewMonth = Number(iso.slice(5, 7));
    render();
  }

  function shiftMonth(delta) {
    viewMonth += delta;
    if (viewMonth < 1) {
      viewMonth = 12;
      viewYear -= 1;
    } else if (viewMonth > 12) {
      viewMonth = 1;
      viewYear += 1;
    }
    render();
  }

  function onListClick(event) {
    var button = event.target.closest("button");
    if (!button || busy) return;
    var action = button.getAttribute("data-action");
    var row = findException(button.getAttribute("data-id"));
    if (!action || !row) return;
    if (action === "edit") {
      pageMessage("");
      fillForm(row);
      return;
    }
    if (action === "delete") removeException(row);
  }

  function holidayMessage(message, ok) {
    var slot = $("holiday-message");
    if (!slot) return;
    slot.textContent = message || "";
    slot.classList.toggle("is-ok", !!ok && !!message);
  }

  function readBaseYear() {
    var field = $("holiday-base-year");
    if (!field) return null;
    var value = Number(field.value);
    if (value !== Math.floor(value) || value < 1950 || value > 2096) return null;
    return value;
  }

  function holidayWindow(base) {
    var years = [];
    var index;
    for (index = 0; index < HOLIDAY_SPAN; index += 1) years.push(base + index);
    return years;
  }

  function renderHolidayYears() {
    var base = readBaseYear();
    var choices = $("holiday-year-choices");
    var deleteYear = $("holiday-delete-year");
    if (base == null) return;
    var previousDelete = deleteYear ? deleteYear.value : String(HOLIDAY_BASE_DEFAULT);
    if (choices) {
      clearNode(choices);
      holidayWindow(base).forEach(function (year) {
        var label = document.createElement("label");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.className = "holiday-year-check";
        input.value = String(year);
        input.checked = true;
        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + year + "年"));
        choices.appendChild(label);
      });
    }
    if (deleteYear) {
      clearNode(deleteYear);
      holidayWindow(base).forEach(function (year) {
        var option = document.createElement("option");
        option.value = String(year);
        option.textContent = year + "年";
        deleteYear.appendChild(option);
      });
      var hasPrevious = false;
      for (var optionIndex = 0; optionIndex < deleteYear.options.length; optionIndex += 1) {
        if (deleteYear.options[optionIndex].value === previousDelete) hasPrevious = true;
      }
      deleteYear.value = hasPrevious ? previousDelete : String(base);
    }
  }

  function selectedHolidayYears() {
    var years = [];
    var inputs = document.querySelectorAll(".holiday-year-check");
    for (var index = 0; index < inputs.length; index += 1) {
      if (!inputs[index].checked) continue;
      var year = Number(inputs[index].value);
      if (year >= 1950 && year <= 2100) years.push(year);
    }
    return years;
  }

  function yearLabel(years) {
    return years.map(function (year) { return year + "年"; }).join("・");
  }

  function planHasInsert() {
    return holidayState.ready && holidayState.insertCount > 0;
  }

  function syncHolidayWriteButtons() {
    var importButton = $("holiday-import");
    if (importButton) importButton.disabled = busy || !HOLIDAY_DB_CONFIRMED || !planHasInsert();
    var deleteButton = $("holiday-delete-run");
    if (deleteButton) deleteButton.disabled = busy || !HOLIDAY_DB_CONFIRMED || selectedDeleteIds().length < 1;
  }

  function invalidateHolidayPlan() {
    holidayState.ready = false;
    holidayState.insertCount = 0;
    syncHolidayWriteButtons();
  }

  function pad2(value) {
    return (value < 10 ? "0" : "") + value;
  }

  function addIsoDays(iso, days) {
    var parts = iso.split("-");
    var utc = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + days));
    return utc.getUTCFullYear() + "-" + pad2(utc.getUTCMonth() + 1) + "-" + pad2(utc.getUTCDate());
  }

  function parseOfficialDate(value) {
    var matched = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(trim(value));
    if (!matched) return "";
    var year = Number(matched[1]);
    var month = Number(matched[2]);
    var day = Number(matched[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return "";
    var utc = new Date(Date.UTC(year, month - 1, day));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return "";
    return year + "-" + pad2(month) + "-" + pad2(day);
  }

  function splitHolidayLine(line) {
    var text = trim(String(line).replace(/^\uFEFF/, ""));
    if (!text) return { empty: true };
    if (text.indexOf('"') !== -1) return { error: "引用符を含む行は内閣府CSVの形式と一致しません。" };
    var comma = text.indexOf(",");
    if (comma < 0 || text.indexOf(",", comma + 1) !== -1) {
      return { error: "日付と名称の2列ではありません。" };
    }
    return {
      dateText: trim(text.slice(0, comma)),
      name: trim(text.slice(comma + 1))
    };
  }

  function holidayHeaderOk(text) {
    var lines = String(text || "").split(/\r?\n/);
    var index;
    for (index = 0; index < lines.length; index += 1) {
      var parsed = splitHolidayLine(lines[index]);
      if (parsed.empty) continue;
      return !parsed.error && parsed.dateText === HOLIDAY_HEADER_DATE && parsed.name === HOLIDAY_HEADER_NAME;
    }
    return false;
  }

  function decodeHolidayCsv(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var start = 0;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) start = 3;
    var slice = bytes.subarray(start);
    var utf8Text = "";
    try {
      utf8Text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch (error) {
      utf8Text = "";
    }
    var shiftText = "";
    try {
      shiftText = new TextDecoder("shift_jis").decode(slice);
    } catch (error) {
      shiftText = "";
    }
    if (utf8Text && holidayHeaderOk(utf8Text)) return { text: utf8Text, encoding: "UTF-8" };
    if (shiftText && holidayHeaderOk(shiftText)) return { text: shiftText, encoding: "Shift_JIS" };
    if (utf8Text) return { text: utf8Text, encoding: "UTF-8" };
    if (shiftText) return { text: shiftText, encoding: "Shift_JIS" };
    return { error: "CSVの文字コードをUTF-8またはShift_JISとして読めません。内閣府の国民の祝日CSVを選択してください。" };
  }

  function countHolidayActions(rows) {
    var counts = { insert: 0, registered: 0, conflict: 0, skip: 0, unclassified: 0, duplicate: 0 };
    rows.forEach(function (row) {
      if (Object.prototype.hasOwnProperty.call(counts, row.action)) counts[row.action] += 1;
    });
    return counts;
  }

  function existingHolidayDecision(kind, name, existing) {
    if (!existing) {
      return {
        action: "insert",
        resultText: "登録予定",
        detail: "新規に登録します。理由の表示はオフのままです。"
      };
    }
    var kindName = kindLabel(existing.kind) || "登録済み";
    var hasNote = trim(existing.admin_note) !== "";
    var same = existing.kind === kind && trim(existing.public_reason) === name;
    if (existing.kind === "temporary_closure" || existing.kind === "special_open" || hasNote || !same) {
      var detail = "既存の" + kindName + "を上書きしないためスキップします。";
      if (hasNote) detail += "管理者メモは変更しません。";
      return { action: "conflict", resultText: "競合", detail: detail };
    }
    return {
      action: "registered",
      resultText: "登録済み",
      detail: "同じ日付が既に登録されているため変更しません。"
    };
  }

  function parseHolidayCsv(text, years, existingRows) {
    var yearMap = {};
    (years || []).forEach(function (year) {
      var number = Number(year);
      if (number >= 1950 && number <= 2100) yearMap[number] = true;
    });
    var lines = String(text || "").split(/\r?\n/);
    var errors = [];
    var records = [];
    var headerIndex = -1;
    var index;
    for (index = 0; index < lines.length; index += 1) {
      var parsed = splitHolidayLine(lines[index]);
      if (parsed.empty) continue;
      if (headerIndex < 0) {
        headerIndex = index;
        if (parsed.error || parsed.dateText !== HOLIDAY_HEADER_DATE || parsed.name !== HOLIDAY_HEADER_NAME) {
          return { error: "先頭行が「国民の祝日・休日月日,国民の祝日・休日名称」ではありません。" };
        }
        continue;
      }
      var lineNo = index + 1;
      if (parsed.error) {
        errors.push({ line: lineNo, detail: parsed.error });
        continue;
      }
      var iso = parseOfficialDate(parsed.dateText);
      if (!iso) {
        errors.push({ line: lineNo, detail: "日付が正しくありません。" });
        continue;
      }
      if (!parsed.name) {
        errors.push({ line: lineNo, detail: iso + " の名称が空です。" });
        continue;
      }
      if (parsed.name.length > 200) {
        errors.push({ line: lineNo, detail: iso + " の名称が200文字を超えています。" });
        continue;
      }
      records.push({ line: lineNo, date: iso, name: parsed.name, year: Number(iso.slice(0, 4)) });
    }
    if (headerIndex < 0) return { error: "CSVに見出し行がありません。" };

    var dateCount = {};
    records.forEach(function (record) {
      dateCount[record.date] = (dateCount[record.date] || 0) + 1;
    });
    var named = {};
    records.forEach(function (record) {
      if (dateCount[record.date] !== 1) return;
      if (record.name === "休日" || record.name === "国民の休日" || record.name === "振替休日") return;
      named[record.date] = record.name;
    });
    var substituteSources = {};
    Object.keys(named).forEach(function (iso) {
      if (weekdayOfDate(iso) !== 0) return;
      var next = addIsoDays(iso, 1);
      var guard = 0;
      while (named[next] && guard < 14) {
        next = addIsoDays(next, 1);
        guard += 1;
      }
      if (!named[next]) {
        if (!substituteSources[next]) substituteSources[next] = [];
        substituteSources[next].push(iso);
      }
    });
    var citizens = {};
    Object.keys(named).forEach(function (iso) {
      var next = addIsoDays(iso, 1);
      var after = addIsoDays(iso, 2);
      if (!named[next] && named[after]) citizens[next] = true;
    });

    var existingByDate = {};
    (existingRows || []).forEach(function (row) {
      var iso = dateKey(row.exception_date);
      if (iso) existingByDate[iso] = row;
    });

    var rows = [];
    var ignored = 0;
    records.forEach(function (record) {
      if (!yearMap[record.year]) {
        ignored += 1;
        return;
      }
      var base = { line: record.line, date: record.date, name: record.name, kind: "", kindText: "" };
      if (dateCount[record.date] !== 1) {
        base.action = "duplicate";
        base.resultText = "登録しない";
        base.kindText = "重複";
        base.detail = "CSV内で同じ日付が複数あるため登録しません。";
        rows.push(base);
        return;
      }
      if (record.name === "国民の休日") {
        base.action = "skip";
        base.resultText = "登録しない";
        base.kindText = "国民の休日";
        base.detail = "国民の休日です。休業日の区分がないため登録しません。";
        rows.push(base);
        return;
      }
      if (record.name === "休日") {
        var sources = substituteSources[record.date] || [];
        var isSubstitute = sources.length === 1;
        var isCitizen = !!citizens[record.date];
        if (isSubstitute && !isCitizen) {
          base.kind = "substitute_holiday";
          base.kindText = "振替休日";
          var decision = existingHolidayDecision(base.kind, record.name, existingByDate[record.date]);
          base.action = decision.action;
          base.resultText = decision.resultText;
          base.detail = decision.detail + sources[0] + "が日曜日の祝日であるため振替休日と判定しました。";
          rows.push(base);
          return;
        }
        if (isCitizen && sources.length === 0) {
          base.action = "skip";
          base.resultText = "登録しない";
          base.kindText = "国民の休日";
          base.detail = "前後が祝日に挟まれた国民の休日です。休業日の区分がないため登録しません。";
          rows.push(base);
          return;
        }
        base.action = "unclassified";
        base.resultText = "登録しない";
        base.kindText = "判別不能";
        base.detail = sources.length && isCitizen
          ? "振替休日の条件と国民の休日の条件の両方に当たるため、推測では登録しません。"
          : "祝日法の振替休日にも国民の休日にも一致しないため登録しません。";
        rows.push(base);
        return;
      }
      base.kind = record.name === "振替休日" ? "substitute_holiday" : "holiday";
      base.kindText = base.kind === "substitute_holiday" ? "振替休日" : "祝日";
      var namedDecision = existingHolidayDecision(base.kind, record.name, existingByDate[record.date]);
      base.action = namedDecision.action;
      base.resultText = namedDecision.resultText;
      base.detail = namedDecision.detail;
      rows.push(base);
    });
    rows.sort(function (left, right) {
      if (left.date < right.date) return -1;
      if (left.date > right.date) return 1;
      return left.line - right.line;
    });
    var listedByYear = {};
    records.forEach(function (record) {
      listedByYear[record.year] = (listedByYear[record.year] || 0) + 1;
    });
    return { rows: rows, errors: errors, ignored: ignored, listedByYear: listedByYear };
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function holidayDateLabel(iso) {
    return iso + "（" + WEEKDAYS[weekdayOfDate(iso)] + "）";
  }

  function renderHolidayPlan(parsed, encoding) {
    var counts = countHolidayActions(parsed.rows);
    holidayState.insertCount = counts.insert;
    holidayState.ready = true;
    syncHolidayWriteButtons();
    var summary = $("holiday-summary");
    summary.hidden = false;
    var outside = parsed.ignored ? "対象年以外の" + parsed.ignored + "件は取り込みません。" : "";
    var unlistedYears = holidayState.years.filter(function (year) {
      return !parsed.listedByYear || !parsed.listedByYear[year];
    });
    var unlistedText = unlistedYears.length ? "未収録は" + unlistedYears.map(function (year) { return year + "年"; }).join("・") + "です。この年の祝日は作っていません。" : "";
    summary.textContent = encoding + "として読みました。" + yearLabel(holidayState.years) + "は、登録予定" + counts.insert + "件、登録済み" + counts.registered + "件、競合" + counts.conflict + "件、登録しない" + (counts.skip + counts.unclassified + counts.duplicate) + "件です。" + unlistedText + outside;
    renderHolidayYearSummary(parsed);

    var errorWrap = $("holiday-errors");
    var errorList = $("holiday-error-list");
    clearNode(errorList);
    errorWrap.hidden = parsed.errors.length === 0;
    parsed.errors.slice(0, 30).forEach(function (error) {
      var item = document.createElement("li");
      item.textContent = error.line + "行目: " + error.detail;
      errorList.appendChild(item);
    });
    if (parsed.errors.length > 30) {
      var more = document.createElement("li");
      more.textContent = "他" + (parsed.errors.length - 30) + "件";
      errorList.appendChild(more);
    }

    var wrap = $("holiday-preview-wrap");
    var body = $("holiday-preview-body");
    var cards = $("holiday-preview-cards");
    clearNode(body);
    clearNode(cards);
    wrap.hidden = parsed.rows.length === 0;
    parsed.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      [holidayDateLabel(row.date), row.name, row.kindText, row.resultText, row.detail].forEach(function (value) {
        var cell = document.createElement("td");
        cell.textContent = value;
        tr.appendChild(cell);
      });
      body.appendChild(tr);

      var card = document.createElement("article");
      card.className = "holiday-card";
      [
        ["日付", holidayDateLabel(row.date)],
        ["祝日名", row.name],
        ["区分", row.kindText],
        ["結果", row.resultText],
        ["内容", row.detail]
      ].forEach(function (pair) {
        var paragraph = document.createElement("p");
        paragraph.textContent = pair[0] + ": " + pair[1];
        card.appendChild(paragraph);
      });
      cards.appendChild(card);
    });
    return counts;
  }

  function renderHolidayYearSummary(parsed) {
    var wrap = $("holiday-year-summary-wrap");
    var body = $("holiday-year-body");
    var cards = $("holiday-year-cards");
    if (!wrap || !body || !cards) return;
    clearNode(body);
    clearNode(cards);
    wrap.hidden = false;
    holidayState.years.forEach(function (year) {
      var rows = parsed.rows.filter(function (row) {
        return Number(row.date.slice(0, 4)) === year;
      });
      var counts = countHolidayActions(rows);
      var unlisted = parsed.listedByYear && parsed.listedByYear[year] ? 0 : 1;
      var values = [year + "年", String(counts.insert), String(counts.registered), String(counts.conflict), String(unlisted)];
      var tr = document.createElement("tr");
      values.forEach(function (value) {
        var cell = document.createElement("td");
        cell.textContent = value;
        tr.appendChild(cell);
      });
      body.appendChild(tr);
      var card = document.createElement("article");
      card.className = "holiday-card";
      ["年", "登録予定", "登録済み", "競合", "未収録"].forEach(function (label, index) {
        var paragraph = document.createElement("p");
        paragraph.textContent = label + ": " + values[index];
        card.appendChild(paragraph);
      });
      cards.appendChild(card);
    });
  }

  function readHolidayFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error("CSVファイルを選択してください。"));
        return;
      }
      if (file.size > 1024 * 1024) {
        reject(new Error("CSVファイルが大きすぎます。内閣府の国民の祝日CSVを選択してください。"));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("CSVファイルを読み込めませんでした。"));
      };
      reader.onload = function () {
        var decoded = decodeHolidayCsv(reader.result);
        if (decoded.error) reject(new Error(decoded.error));
        else resolve(decoded);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function selectExceptions(supabaseClient) {
    return supabaseClient
      .from("business_calendar_exceptions")
      .select(EXCEPTION_COLUMNS)
      .order("exception_date", { ascending: true })
      .then(function (result) {
        if (result.error) fail(result.error, "休業日を読み込めませんでした。", result.status);
        return result.data || [];
      });
  }

  function confirmHolidayText(counts) {
    var skipped = counts.skip + counts.unclassified + counts.duplicate;
    return yearLabel(holidayState.years) + "の祝日CSVから、登録予定" + counts.insert + "件を登録します。登録済み" + counts.registered + "件、競合" + counts.conflict + "件、登録しない" + skipped + "件は変更しません。CSVに無い既存の休業日は削除しません。よろしいですか？";
  }

  function insertHolidayRows(supabaseClient, rows) {
    if (!HOLIDAY_DB_CONFIRMED) {
      return Promise.reject(new Error("登録は、データベースの準備と管理者権限の確認が終わるまで行えません。"));
    }
    var inserted = 0;
    var skipped = 0;
    var index = 0;
    function next() {
      if (index >= rows.length) return Promise.resolve({ inserted: inserted, skipped: skipped });
      var row = rows[index];
      index += 1;
      return supabaseClient
        .rpc("insert_imported_calendar_holiday", {
          p_exception_date: row.date,
          p_kind: row.kind,
          p_public_reason: row.name
        })
        .then(function (result) {
          if (result.error) {
            var code = result.error.code ? String(result.error.code) : "";
            if (code === "23505") {
              skipped += 1;
              return next();
            }
            fail(result.error, "祝日を登録できませんでした。", result.status);
          }
          if (!result.data) throw new Error("祝日を登録できませんでした。");
          inserted += 1;
          return next();
        });
    }
    return next();
  }

  function previewHolidayFile() {
    if (busy) return;
    var years = selectedHolidayYears();
    if (!years.length) {
      invalidateHolidayPlan();
      holidayMessage("基準年から5年の範囲で、1年以上を選択してください。", false);
      return;
    }
    var input = $("holiday-file");
    var file = input && input.files ? input.files[0] : null;
    pageMessage("");
    holidayMessage("");
    setBusy(true);
    readHolidayFile(file).then(function (decoded) {
      return withSession().then(function (supabaseClient) {
        return selectExceptions(supabaseClient).then(function (rows) {
          exceptions = rows;
          render();
          holidayState.text = decoded.text;
          holidayState.encoding = decoded.encoding;
          holidayState.years = years.slice();
          var parsed = parseHolidayCsv(decoded.text, years, exceptions);
          if (parsed.error) throw new Error(parsed.error);
          var counts = renderHolidayPlan(parsed, decoded.encoding);
          if (!parsed.rows.length && !parsed.errors.length) {
            holidayMessage("選択した年の日付はCSVにありません。祝日は作っていません。", false);
            return;
          }
          holidayMessage("内容を確認しました。登録予定は" + counts.insert + "件です。登録はまだ行っていません。", true);
        });
      });
    }).catch(function (error) {
      invalidateHolidayPlan();
      holidayMessage(error && error.message ? error.message : "CSVを読み込めませんでした。", false);
    }).then(function () {
      setBusy(false);
    });
  }

  function importHolidayFile() {
    if (!HOLIDAY_DB_CONFIRMED) {
      holidayMessage("登録は、データベースの準備と管理者権限の確認が終わるまで行えません。", false);
      return;
    }
    if (busy || !holidayState.ready) return;
    pageMessage("");
    holidayMessage("");
    setBusy(true);
    withSession().then(function (supabaseClient) {
      return selectExceptions(supabaseClient).then(function (rows) {
        exceptions = rows;
        var parsed = parseHolidayCsv(holidayState.text, holidayState.years, exceptions);
        if (parsed.error) throw new Error(parsed.error);
        var counts = renderHolidayPlan(parsed, holidayState.encoding);
        var planned = parsed.rows.filter(function (row) { return row.action === "insert"; });
        if (!planned.length) {
          holidayMessage("登録できる日付がありません。", false);
          return null;
        }
        var agreed = window.confirm(confirmHolidayText(counts));
        if (!agreed) {
          holidayMessage("登録を中止しました。", false);
          return null;
        }
        return insertHolidayRows(supabaseClient, planned).then(function (summary) {
          return loadAll().then(function () {
            var again = parseHolidayCsv(holidayState.text, holidayState.years, exceptions);
            if (!again.error) renderHolidayPlan(again, holidayState.encoding);
            var text = summary.inserted + "件を登録しました。";
            if (summary.skipped) text += summary.skipped + "件は競合のためスキップしました。";
            text += "CSVに無い既存の休業日は削除していません。";
            holidayMessage(text, true);
            pageMessage(text, true);
          });
        });
      });
    }).catch(function (error) {
      holidayMessage(error && error.message ? error.message : "祝日を登録できませんでした。", false);
      return loadAll().catch(function () {
        return null;
      });
    }).then(function () {
      setBusy(false);
    });
  }

  function deleteMessage(message, ok) {
    var slot = $("holiday-delete-message");
    if (!slot) return;
    slot.textContent = message || "";
    slot.classList.toggle("is-ok", !!ok && !!message);
  }

  function isCsvDeleteCandidate(row, year) {
    var iso = dateKey(row && row.exception_date);
    if (!iso || Number(iso.slice(0, 4)) !== year) return false;
    if (row.import_source !== "cabinet_csv") return false;
    if (row.kind !== "holiday" && row.kind !== "substitute_holiday") return false;
    if (trim(row.admin_note)) return false;
    return true;
  }

  function selectedDeleteIds() {
    var ids = [];
    var inputs = document.querySelectorAll(".holiday-delete-check");
    for (var index = 0; index < inputs.length; index += 1) {
      if (inputs[index].checked && inputs[index].value) ids.push(inputs[index].value);
    }
    return ids;
  }

  function renderDeleteCandidates(rows, year) {
    var list = $("holiday-delete-list");
    var count = $("holiday-delete-count");
    clearNode(list);
    var candidates = [];
    var excluded = 0;
    (rows || []).forEach(function (row) {
      var iso = dateKey(row.exception_date);
      if (!iso || Number(iso.slice(0, 4)) !== year) return;
      if (isCsvDeleteCandidate(row, year)) candidates.push(row);
      else excluded += 1;
    });
    candidates.sort(function (left, right) {
      var leftDate = dateKey(left.exception_date);
      var rightDate = dateKey(right.exception_date);
      if (leftDate < rightDate) return -1;
      if (leftDate > rightDate) return 1;
      return 0;
    });
    count.hidden = false;
    count.textContent = year + "年の削除候補は" + candidates.length + "件です。候補以外は" + excluded + "件あり、削除候補に入れていません。";
    if (!candidates.length) {
      var empty = document.createElement("p");
      empty.textContent = "削除できるCSV由来の祝日はありません。";
      list.appendChild(empty);
      syncHolidayWriteButtons();
      return;
    }
    candidates.forEach(function (row) {
      var item = document.createElement("label");
      item.className = "holiday-delete-item";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.className = "holiday-delete-check";
      input.value = row.id ? String(row.id) : "";
      input.checked = false;
      var text = document.createElement("span");
      text.textContent = holidayDateLabel(dateKey(row.exception_date)) + " " + (row.public_reason ? String(row.public_reason) : "名称なし") + " " + kindLabel(row.kind);
      item.appendChild(input);
      item.appendChild(text);
      list.appendChild(item);
    });
    syncHolidayWriteButtons();
  }

  function previewDeleteCandidates() {
    if (busy) return;
    var year = Number($("holiday-delete-year") && $("holiday-delete-year").value);
    if (!(year >= 1950 && year <= 2100)) {
      deleteMessage("対象年を選択してください。", false);
      return;
    }
    deleteMessage("");
    setBusy(true);
    withSession().then(function (supabaseClient) {
      var nextYear = year + 1;
      return supabaseClient
        .from("business_calendar_exceptions")
        .select("id, exception_date, kind, public_reason, admin_note, import_source")
        .gte("exception_date", year + "-01-01")
        .lt("exception_date", nextYear + "-01-01")
        .order("exception_date", { ascending: true })
        .then(function (result) {
          if (result.error) {
            logSupabaseError(result.error, result.status);
            clearNode($("holiday-delete-list"));
            $("holiday-delete-count").hidden = true;
            deleteMessage("削除候補を表示できません。データベースの準備が確認できるまで、CSV由来の行は判定しません。", false);
            return;
          }
          renderDeleteCandidates(result.data || [], year);
          deleteMessage("削除候補を表示しました。削除はまだ行っていません。", true);
        });
    }).catch(function (error) {
      deleteMessage(error && error.message ? error.message : "削除候補を表示できませんでした。", false);
    }).then(function () {
      setBusy(false);
    });
  }

  function deleteSelectedHolidays() {
    if (!HOLIDAY_DB_CONFIRMED) {
      deleteMessage("削除は、データベースの準備と管理者権限の確認が終わるまで行えません。", false);
      return;
    }
    if (busy) return;
    var year = Number($("holiday-delete-year") && $("holiday-delete-year").value);
    var ids = selectedDeleteIds();
    if (!ids.length) {
      deleteMessage("削除する祝日を選択してください。", false);
      return;
    }
    var agreed = window.confirm(year + "年のCSV由来の祝日" + ids.length + "件を削除します。手入力、臨時休業、特別営業、管理者メモ付きは削除しません。指定年以外が含まれる場合は1件も削除しません。よろしいですか？");
    if (!agreed) {
      deleteMessage("削除を中止しました。", false);
      return;
    }
    setBusy(true);
    withSession().then(function (supabaseClient) {
      return supabaseClient.rpc("delete_imported_calendar_holidays", {
        p_year: year,
        p_ids: ids
      }).then(function (result) {
        if (result.error) fail(result.error, "祝日を削除できませんでした。", result.status);
        var deleted = result.data || [];
        if (deleted.length !== ids.length) {
          throw new Error("削除件数が一致しないため、結果を確認してください。");
        }
        return loadAll().then(function () {
          clearNode($("holiday-delete-list"));
          $("holiday-delete-count").hidden = true;
          deleteMessage(deleted.length + "件を削除しました。候補を再表示してください。", true);
          pageMessage(deleted.length + "件を削除しました。", true);
        });
      });
    }).catch(function (error) {
      deleteMessage(error && error.message ? error.message : "祝日を削除できませんでした。", false);
      return loadAll().catch(function () { return null; });
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
    var today = japanTodayParts();
    viewYear = today.year;
    viewMonth = today.month;
    $("closure-form").addEventListener("submit", saveForm);
    $("exception-kind").addEventListener("change", function () {
      var special = $("exception-kind").value === "special_open";
      var previousOpens = $("special-opens").value;
      syncKind();
      if (special && !previousOpens) {
        $("special-opens").value = "10:00";
        $("special-closes").value = "21:00";
        $("special-last").value = "18:30";
      }
    });
    $("closure-reset").addEventListener("click", function () {
      pageMessage("");
      resetForm("");
    });
    $("closure-reload").addEventListener("click", function () {
      if (busy) return;
      pageMessage("");
      formMessage("");
      setBusy(true);
      loadAll().then(function () {
        pageMessage("再読み込みしました。", true);
      }).catch(function (error) {
        pageMessage(error && error.message ? error.message : "再読み込みできませんでした。", false);
      }).then(function () {
        setBusy(false);
      });
    });
    $("closure-delete").addEventListener("click", function () {
      removeException(findException(selectedId()));
    });
    $("cal-prev").addEventListener("click", function () {
      if (!busy) shiftMonth(-1);
    });
    $("cal-next").addEventListener("click", function () {
      if (!busy) shiftMonth(1);
    });
    $("cal-grid").addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button || busy) return;
      var iso = button.getAttribute("data-date");
      if (iso) chooseDate(iso);
    });
    $("closure-table").addEventListener("click", onListClick);
    $("closure-cards").addEventListener("click", onListClick);
    renderHolidayYears();
    $("holiday-preview").addEventListener("click", previewHolidayFile);
    $("holiday-import").addEventListener("click", importHolidayFile);
    $("holiday-base-year").addEventListener("change", function () {
      var invalid = readBaseYear() == null;
      if (invalid) $("holiday-base-year").value = String(HOLIDAY_BASE_DEFAULT);
      renderHolidayYears();
      invalidateHolidayPlan();
      holidayMessage(invalid
        ? "基準年は1950年から2096年で入力してください。"
        : "基準年を変更しました。もう一度内容を確認してください。", false);
    });
    $("holiday-year-choices").addEventListener("change", function () {
      if (!holidayState.ready && !holidayState.text) return;
      invalidateHolidayPlan();
      holidayMessage("ファイルまたは年を変更しました。もう一度内容を確認してください。", false);
    });
    $("holiday-file").addEventListener("change", function () {
      if (!holidayState.ready && !holidayState.text) return;
      invalidateHolidayPlan();
      holidayMessage("ファイルまたは年を変更しました。もう一度内容を確認してください。", false);
    });
    $("holiday-delete-preview").addEventListener("click", previewDeleteCandidates);
    $("holiday-delete-run").addEventListener("click", deleteSelectedHolidays);
    $("holiday-delete-list").addEventListener("change", syncHolidayWriteButtons);
    var logout = $("logout-button");
    if (logout && window.LapinaAuth) {
      logout.addEventListener("click", function () {
        logout.disabled = true;
        window.LapinaAuth.signOut();
      });
    }
    syncKind();
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
      return loadAll().catch(function (error) {
        pageMessage(error && error.message ? error.message : "休業日を読み込めませんでした。", false);
      });
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "休業日を開けませんでした。", false);
    });
  });
})();
