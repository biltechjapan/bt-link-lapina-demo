(function () {
  "use strict";

  /*
   * auth.js は変更しない。公開URLと publishable キーで
   * ログイン済みセッションを共有する。RLSは回避しない。
   * service_role は使わない。公開予約画面はこの画面では開かない。
   */
  var SUPABASE_URL = "https://imhfdvscwsaizqvnnztl.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_f9VbCQbX_nMvzEmL1U9oZw_proWYzIl";
  var COLUMNS = "id, name, duration_minutes, price_yen, summary, description, sort_order, is_public, accepts_bookings";

  var client = null;
  var courses = [];
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

  function getClient() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("認証ライブラリを読み込めませんでした。");
    }
    if (!client) {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
    }
    return client;
  }

  function selectedId() {
    return $("course-form").getAttribute("data-id") || "";
  }

  function findCourse(id) {
    for (var i = 0; i < courses.length; i += 1) {
      if (courses[i].id === id) return courses[i];
    }
    return null;
  }

  function sortedCourses() {
    return courses.slice().sort(function (a, b) {
      return a.sort_order - b.sort_order;
    });
  }

  function formatYen(value) {
    return Number(value).toLocaleString("ja-JP") + "円";
  }

  function errorText(error, fallback) {
    var code = error && error.code ? String(error.code) : "";
    var raw = error && error.message ? String(error.message) : "";
    var constraint = "";
    var matched = raw.match(/constraint "([^"]+)"/);
    if (matched) constraint = matched[1];
    if (code === "23505" || /duplicate key/i.test(raw)) {
      if (constraint.indexOf("sort") !== -1) return "この表示順は別のコースで使われています。";
      if (constraint.indexOf("name") !== -1) return "同じコース名が既に登録されています。";
      return "同じコース名、または同じ表示順が既に登録されています。";
    }
    if (code === "23514" || /check constraint/i.test(raw)) {
      if (constraint.indexOf("booking") !== -1) return "非公開のコースは予約受付を有効にできません。";
      if (constraint.indexOf("duration") !== -1) return "施術時間は1分以上で入力してください。";
      if (constraint.indexOf("price") !== -1) return "料金は0円以上の整数で入力してください。";
      if (constraint.indexOf("sort") !== -1) return "表示順は1以上の整数で入力してください。";
      if (constraint.indexOf("name") !== -1) return "コース名を入力してください。";
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

  function unusedSort() {
    var used = {};
    courses.forEach(function (course) {
      used[course.sort_order] = true;
    });
    var number = 1;
    while (used[number]) {
      number += 1;
      if (number > 2147483647) return null;
    }
    return number;
  }

  function duplicateName(name, currentId) {
    for (var i = 0; i < courses.length; i += 1) {
      if (courses[i].id !== currentId && trim(courses[i].name) === name) return courses[i];
    }
    return null;
  }

  function courseBySort(sortOrder, currentId) {
    for (var i = 0; i < courses.length; i += 1) {
      if (courses[i].id !== currentId && courses[i].sort_order === sortOrder) return courses[i];
    }
    return null;
  }

  function setBusy(next) {
    busy = next;
    ["course-save", "course-reset", "course-delete"].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = next;
    });
    if (!next) {
      render();
      return;
    }
    var buttons = document.querySelectorAll(".course-row-action");
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
  }

  function badge(text, className) {
    var mark = document.createElement("span");
    mark.className = "course-badge " + className;
    mark.textContent = text;
    return mark;
  }

  function publicBadge(course) {
    return course.is_public === true
      ? badge("公開", "is-public")
      : badge("非公開", "is-private");
  }

  function bookingBadge(course) {
    return course.accepts_bookings === true
      ? badge("受付中", "is-booking")
      : badge("停止", "is-stopped");
  }

  function actionButton(label, action, id, extraClass) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "button-quiet course-row-action" + (extraClass ? " " + extraClass : "");
    button.setAttribute("data-action", action);
    button.setAttribute("data-id", id);
    button.textContent = label;
    return button;
  }

  function actionGroup(course, index, total) {
    var group = document.createElement("div");
    group.className = "course-actions";
    group.appendChild(actionButton("編集", "edit", course.id));
    var up = actionButton("上へ", "up", course.id);
    var down = actionButton("下へ", "down", course.id);
    if (index === 0) up.disabled = true;
    if (index === total - 1) down.disabled = true;
    group.appendChild(up);
    group.appendChild(down);
    group.appendChild(actionButton("削除", "delete", course.id, "course-delete"));
    return group;
  }

  function render() {
    var rows = sortedCourses();
    var table = $("course-table");
    var cards = $("course-cards");
    var empty = $("course-empty");
    var tableWrap = document.querySelector(".course-table-wrap");
    var currentId = selectedId();
    table.innerHTML = "";
    cards.innerHTML = "";
    empty.hidden = rows.length > 0;
    if (tableWrap) tableWrap.hidden = rows.length === 0;
    cards.hidden = rows.length === 0;

    rows.forEach(function (course, index) {
      var tr = document.createElement("tr");
      if (course.id === currentId) tr.className = "is-selected";

      var sortCell = document.createElement("td");
      sortCell.textContent = String(course.sort_order);
      tr.appendChild(sortCell);

      var nameCell = document.createElement("td");
      var name = document.createElement("div");
      name.className = "course-name";
      name.textContent = course.name ? String(course.name) : "";
      nameCell.appendChild(name);
      if (course.summary) {
        var summary = document.createElement("div");
        summary.className = "course-summary";
        summary.textContent = String(course.summary);
        nameCell.appendChild(summary);
      }
      tr.appendChild(nameCell);

      var durationCell = document.createElement("td");
      durationCell.textContent = String(course.duration_minutes) + "分";
      tr.appendChild(durationCell);

      var priceCell = document.createElement("td");
      priceCell.textContent = formatYen(course.price_yen);
      tr.appendChild(priceCell);

      var publicCell = document.createElement("td");
      publicCell.appendChild(publicBadge(course));
      tr.appendChild(publicCell);

      var bookingCell = document.createElement("td");
      bookingCell.appendChild(bookingBadge(course));
      tr.appendChild(bookingCell);

      var actionCell = document.createElement("td");
      actionCell.appendChild(actionGroup(course, index, rows.length));
      tr.appendChild(actionCell);
      table.appendChild(tr);

      var card = document.createElement("article");
      card.className = "patient-item course-card" + (course.id === currentId ? " is-selected" : "");
      var main = document.createElement("div");
      main.className = "patient-main";
      var order = document.createElement("div");
      order.className = "patient-no";
      order.textContent = "表示順 " + course.sort_order;
      var title = document.createElement("div");
      title.className = "patient-name";
      title.textContent = course.name ? String(course.name) : "";
      main.appendChild(order);
      main.appendChild(title);
      var meta = document.createElement("div");
      meta.className = "patient-meta";
      meta.textContent = String(course.duration_minutes) + "分 / " + formatYen(course.price_yen);
      main.appendChild(meta);
      if (course.summary) {
        var cardSummary = document.createElement("div");
        cardSummary.className = "course-summary";
        cardSummary.textContent = String(course.summary);
        main.appendChild(cardSummary);
      }
      var marks = document.createElement("div");
      marks.className = "course-marks";
      marks.appendChild(publicBadge(course));
      marks.appendChild(bookingBadge(course));
      main.appendChild(marks);
      card.appendChild(main);
      card.appendChild(actionGroup(course, index, rows.length));
      cards.appendChild(card);
    });

    if (!busy) return;
    var buttons = document.querySelectorAll(".course-row-action");
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
  }

  function resetForm() {
    var form = $("course-form");
    form.removeAttribute("data-id");
    form.reset();
    $("course-public").checked = false;
    $("course-bookings").checked = false;
    $("course-delete").hidden = true;
    $("form-title").textContent = "コースの登録";
    var next = unusedSort();
    $("course-sort").value = next == null ? "" : String(next);
    formMessage("");
    render();
  }

  function fillForm(course) {
    $("course-form").setAttribute("data-id", course.id);
    $("course-name").value = course.name ? String(course.name) : "";
    $("course-duration").value = String(course.duration_minutes);
    $("course-price").value = String(course.price_yen);
    $("course-summary").value = course.summary ? String(course.summary) : "";
    $("course-description").value = course.description ? String(course.description) : "";
    $("course-sort").value = String(course.sort_order);
    $("course-public").checked = course.is_public === true;
    $("course-bookings").checked = course.accepts_bookings === true;
    $("course-delete").hidden = false;
    $("form-title").textContent = "コースの編集";
    formMessage("");
    render();
  }

  function readForm() {
    var currentId = selectedId();
    var name = trim($("course-name").value);
    if (!name) return { error: "コース名を入力してください。" };
    if (name.length > 100) return { error: "コース名は100文字以内で入力してください。" };
    var duration = parseInteger($("course-duration").value, "施術時間", 1, 1440);
    if (duration.error) return duration;
    var price = parseInteger($("course-price").value, "料金", 0, null);
    if (price.error) return price;
    var summary = trim($("course-summary").value);
    if (summary.length > 200) return { error: "見出しは200文字以内で入力してください。" };
    var description = trim($("course-description").value);
    if (description.length > 2000) return { error: "説明文は2000文字以内で入力してください。" };
    var sort = parseInteger($("course-sort").value, "表示順", 1, null);
    if (sort.error) return sort;
    var isPublic = $("course-public").checked === true;
    var acceptsBookings = $("course-bookings").checked === true;
    if (!isPublic && acceptsBookings) {
      return { error: "非公開のコースは予約受付を有効にできません。先に公開するか、予約受付を外してください。" };
    }
    if (duplicateName(name, currentId)) {
      return { error: "同じコース名が既に登録されています。" };
    }
    return {
      value: {
        name: name,
        duration_minutes: duration.value,
        price_yen: price.value,
        summary: summary ? summary : null,
        description: description ? description : null,
        sort_order: sort.value,
        is_public: isPublic,
        accepts_bookings: acceptsBookings
      }
    };
  }

  function loadCourses() {
    return getClient()
      .from("service_courses")
      .select(COLUMNS)
      .order("sort_order", { ascending: true })
      .then(function (result) {
        if (result.error) throw new Error(errorText(result.error, "コースを読み込めませんでした。"));
        courses = result.data || [];
        render();
        var current = findCourse(selectedId());
        if (!current && !selectedId()) {
          var next = unusedSort();
          if (next != null && !$("course-sort").value) $("course-sort").value = String(next);
        }
      });
  }

  function updateSort(id, fromSort, toSort) {
    return getClient()
      .from("service_courses")
      .update({ sort_order: toSort })
      .eq("id", id)
      .eq("sort_order", fromSort)
      .select("id")
      .maybeSingle()
      .then(function (result) {
        if (result.error) throw new Error(errorText(result.error, "表示順を更新できませんでした。"));
        if (!result.data) throw new Error("表示順を更新できませんでした。一覧を更新して再度お試しください。");
      });
  }

  function swapSort(course, other) {
    var temp = unusedSort();
    var original = course.sort_order;
    var target = other.sort_order;
    if (temp == null) return Promise.reject(new Error("入れ替え用の空き番号がありません。"));
    return updateSort(course.id, original, temp).then(function () {
      return updateSort(other.id, target, original).then(function () {
        return updateSort(course.id, temp, target).catch(function (error) {
          return updateSort(other.id, original, target).then(function () {
            return updateSort(course.id, temp, original);
          }).then(function () {
            throw error;
          }, function () {
            throw new Error("表示順の入れ替えが途中で止まったため、一覧を再取得します。");
          });
        });
      }, function (error) {
        return updateSort(course.id, temp, original).then(function () {
          throw error;
        }, function () {
          throw error;
        });
      });
    });
  }

  function saveCourse(event) {
    event.preventDefault();
    if (busy) return;
    pageMessage("");
    formMessage("");
    var built = readForm();
    if (built.error) {
      formMessage(built.error);
      return;
    }
    var payload = built.value;
    var currentId = selectedId();
    var current = currentId ? findCourse(currentId) : null;
    var occupied = courseBySort(payload.sort_order, currentId);
    if (!current && occupied) {
      formMessage("表示順 " + payload.sort_order + " は「" + occupied.name + "」が使用しています。別の番号を指定してください。");
      return;
    }
    if (current && occupied) {
      var agreed = window.confirm(
        "表示順 " + payload.sort_order + " は「" + occupied.name + "」が使用しています。表示順を入れ替えますか？"
      );
      if (!agreed) return;
    }

    var fields = {
      name: payload.name,
      duration_minutes: payload.duration_minutes,
      price_yen: payload.price_yen,
      summary: payload.summary,
      description: payload.description,
      is_public: payload.is_public,
      accepts_bookings: payload.accepts_bookings
    };
    if (!occupied) fields.sort_order = payload.sort_order;

    setBusy(true);
    var request;
    if (!current) {
      request = getClient()
        .from("service_courses")
        .insert(fields)
        .select("id")
        .single()
        .then(function (result) {
          if (result.error) throw new Error(errorText(result.error, "コースを保存できませんでした。"));
          return result.data && result.data.id;
        });
    } else {
      request = getClient()
        .from("service_courses")
        .update(fields)
        .eq("id", current.id)
        .select("id")
        .maybeSingle()
        .then(function (result) {
          if (result.error) throw new Error(errorText(result.error, "コースを保存できませんでした。"));
          if (!result.data) throw new Error("コースを保存できませんでした。一覧を更新して再度お試しください。");
          if (!occupied) return current.id;
          return swapSort(current, occupied).then(function () {
            return current.id;
          });
        });
    }

    request.then(function (savedId) {
      return loadCourses().then(function () {
        var saved = findCourse(savedId);
        if (saved) fillForm(saved);
        else resetForm();
        pageMessage("保存しました。");
      });
    }).catch(function (error) {
      formMessage(error && error.message ? error.message : "コースを保存できませんでした。");
      return loadCourses();
    }).then(function () {
      setBusy(false);
    });
  }

  function removeCourse(course) {
    if (busy || !course) return;
    var agreed = window.confirm("「" + course.name + "」を削除しますか？この操作は取り消せません。");
    if (!agreed) return;
    pageMessage("");
    formMessage("");
    setBusy(true);
    getClient()
      .from("service_courses")
      .delete()
      .eq("id", course.id)
      .select("id")
      .then(function (result) {
        if (result.error) throw new Error(errorText(result.error, "コースを削除できませんでした。"));
        var removed = result.data || [];
        if (!removed.length) throw new Error("コースを削除できませんでした。一覧を更新して再度お試しください。");
        if (selectedId() === course.id) {
          $("course-form").removeAttribute("data-id");
          $("course-form").reset();
          $("course-delete").hidden = true;
          $("form-title").textContent = "コースの登録";
        }
        return loadCourses().then(function () {
          if (!selectedId()) {
            var next = unusedSort();
            $("course-sort").value = next == null ? "" : String(next);
          }
          pageMessage("削除しました。");
        });
      })
      .catch(function (error) {
        pageMessage(error && error.message ? error.message : "コースを削除できませんでした。");
        return loadCourses();
      })
      .then(function () {
        setBusy(false);
      });
  }

  function moveCourse(course, direction) {
    if (busy || !course) return;
    var rows = sortedCourses();
    var index = -1;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].id === course.id) index = i;
    }
    if (index < 0) return;
    var neighbor = direction < 0 ? rows[index - 1] : rows[index + 1];
    if (!neighbor) return;
    pageMessage("");
    formMessage("");
    setBusy(true);
    swapSort(course, neighbor).then(function () {
      return loadCourses().then(function () {
        pageMessage("表示順を入れ替えました。");
      });
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "表示順を入れ替えられませんでした。");
      return loadCourses();
    }).then(function () {
      setBusy(false);
    });
  }

  function onListClick(event) {
    var button = event.target.closest("button");
    if (!button || busy) return;
    var action = button.getAttribute("data-action");
    var course = findCourse(button.getAttribute("data-id"));
    if (!action || !course) return;
    if (action === "edit") {
      pageMessage("");
      fillForm(course);
      return;
    }
    if (action === "delete") {
      removeCourse(course);
      return;
    }
    if (action === "up") moveCourse(course, -1);
    if (action === "down") moveCourse(course, 1);
  }

  function onPublicChange() {
    if ($("course-public").checked) {
      formMessage("");
      return;
    }
    if ($("course-bookings").checked) {
      $("course-bookings").checked = false;
      formMessage("非公開のコースは予約受付を有効にできないため、予約受付を無効にしました。");
    }
  }

  function onBookingChange() {
    if (!$("course-bookings").checked) {
      formMessage("");
      return;
    }
    if (!$("course-public").checked) {
      $("course-bookings").checked = false;
      formMessage("非公開のコースは予約受付を有効にできません。先に公開してください。");
      return;
    }
    var agreed = window.confirm(
      "このコースの予約受付を有効にします。お客様向けの予約画面は、この操作だけでは公開されません。予約受付を有効にしますか？"
    );
    if (!agreed) $("course-bookings").checked = false;
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
  }

  function bindUi() {
    $("course-form").addEventListener("submit", saveCourse);
    $("course-reset").addEventListener("click", function () {
      pageMessage("");
      resetForm();
    });
    $("course-delete").addEventListener("click", function () {
      removeCourse(findCourse(selectedId()));
    });
    $("course-public").addEventListener("change", onPublicChange);
    $("course-bookings").addEventListener("change", onBookingChange);
    $("course-table").addEventListener("click", onListClick);
    $("course-cards").addEventListener("click", onListClick);
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
        pageMessage(error.message);
        return null;
      }
      showApp(session.user);
      return loadCourses().catch(function (error) {
        pageMessage(error && error.message ? error.message : "コースを読み込めませんでした。");
      });
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "施術コース管理を開けませんでした。");
    });
  });
})();
