/**
 * Live smoke check for your site's Moodle. Run this yourself, locally, with your own
 * token — it never runs in CI and never touches the deployed Worker. It probes
 * which read-only functions your site actually allows, so you can fill the
 * working/blocked table in the README (U6).
 *
 * Usage (PowerShell):
 *   $env:MOODLE_TOKEN = "<your token>"
 *   npm run smoke
 *
 * It prints only function names and status. It never prints the token.
 */

const BASE = (process.env["MOODLE_BASE_URL"] ?? "https://your-moodle.example.com").replace(/\/+$/, "");
const TOKEN = process.env["MOODLE_TOKEN"] ?? "";

if (!TOKEN) {
  console.error("MOODLE_TOKEN is not set. Set it in this shell and re-run (see the script header).");
  process.exit(1);
}
if (!/^https:\/\//i.test(BASE)) {
  console.error("MOODLE_BASE_URL must be https://. Refusing to run.");
  process.exit(1);
}

const ENDPOINT = `${BASE}/webservice/rest/server.php`;

async function call(wsfunction: string, params: Record<string, string> = {}): Promise<unknown> {
  const body = new URLSearchParams({ wstoken: TOKEN, wsfunction, moodlewsrestformat: "json", ...params });
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function classify(payload: unknown): { ok: boolean; note: string } {
  if (payload && typeof payload === "object" && ("exception" in payload || "errorcode" in payload)) {
    const code = String((payload as { errorcode?: string }).errorcode ?? "unknown");
    const blocked = ["accessexception", "nopermissions", "servicenotavailable", "webservicenotavailable"].includes(code);
    return { ok: false, note: blocked ? `BLOCKED (${code})` : `ERROR (${code})` };
  }
  return { ok: true, note: "OK" };
}

async function probe(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const { ok, note } = classify(await fn());
    console.log(`${ok ? "✓" : "✗"} ${label.padEnd(52)} ${note}`);
    return ok;
  } catch (err) {
    console.log(`✗ ${label.padEnd(52)} NETWORK/ERROR (${(err as Error).message})`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`Probing ${BASE} (token hidden)\n`);

  const siteOk = await probe("core_webservice_get_site_info", () => call("core_webservice_get_site_info"));
  let userid = "";
  let sampleCourse = "1127";
  if (siteOk) {
    const info = (await call("core_webservice_get_site_info")) as { fullname?: string; userid?: number };
    console.log(`  connected as: ${info.fullname ?? "?"}`);
    userid = String(info.userid ?? "");
  }

  const timelineOk = await probe(
    "…get_enrolled_courses_by_timeline_classification",
    () => call("core_course_get_enrolled_courses_by_timeline_classification", { classification: "all" }),
  );
  if (timelineOk) {
    const data = (await call("core_course_get_enrolled_courses_by_timeline_classification", {
      classification: "all",
    })) as { courses?: Array<{ id: number }> };
    console.log(`  enrolled courses: ${data.courses?.length ?? 0}`);
    if (data.courses?.[0]) sampleCourse = String(data.courses[0].id);
  }

  await probe(`core_course_get_contents (course ${sampleCourse})`, () =>
    call("core_course_get_contents", { courseid: sampleCourse }),
  );
  await probe("core_calendar_get_action_events_by_timesort", () =>
    call("core_calendar_get_action_events_by_timesort", { timesortfrom: "0", limitnum: "5" }),
  );
  await probe("core_calendar_get_calendar_upcoming_view", () => call("core_calendar_get_calendar_upcoming_view"));
  await probe("mod_forum_get_forums_by_courses", () =>
    call("mod_forum_get_forums_by_courses", { "courseids[0]": sampleCourse }),
  );
  await probe("core_message_get_conversations", () =>
    userid ? call("core_message_get_conversations", { userid }) : Promise.resolve({ errorcode: "no-userid" }),
  );
  await probe(`gradereport_user_get_grade_items (course ${sampleCourse})`, () =>
    userid
      ? call("gradereport_user_get_grade_items", { courseid: sampleCourse, userid })
      : Promise.resolve({ errorcode: "no-userid" }),
  );

  console.log("\nDone. Record each result in the README working/blocked table.");
}

main().catch((err) => {
  console.error("Smoke run failed:", (err as Error).message);
  process.exit(1);
});
