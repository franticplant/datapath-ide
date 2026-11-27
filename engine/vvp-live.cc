/*
 * Datapath Studio browser extensions for vvp (linked by engine/link-browser.sh).
 *
 *  1. Automatic memory / register-file capture for batch runs: every
 *     reg array (vpiMemory) in the design, up to MAX_ARRAYS arrays of up
 *     to MAX_WORDS words, is snapshotted after time 0 settles (so
 *     $readmemh contents count as initial values) and every later word
 *     write is recorded with its simulation time. The result is written
 *     to /work/.datapath_mem.json when the simulation ends.
 *
 *  2. A steppable live session API (vvp_session_*) that keeps the
 *     simulator heap alive between calls, so the browser can poke
 *     inputs and advance time without re-running the design. State is
 *     exchanged through /work/.session_state.json.
 *
 * Copyright (c) 2026 Datapath Studio contributors
 * This source is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 */

# include  "vpi_user.h"
# include  "libvvp.h"
# include  "vpi_priv.h"
# include  <cstdint>
# include  <cstdio>
# include  <cstdlib>
# include  <cstring>
# include  <string>
# include  <vector>

/* Provided by the patched vvp (vvp/schedule.cc, vvp/lib_main.cc). */
extern void schedule_sim_begin(void);
extern int  schedule_sim_run(bool bounded, uint64_t limit, unsigned long max_events);
extern void schedule_sim_end(void);
extern bool schedule_finished(void);
extern uint64_t schedule_simtime(void);
extern int  vvp_live_load(const char *design_path);

namespace {

/* vvp only accepts VPI calls inside a VPI context; enter one like a system task would. */
struct VpiContext {
      vpi_mode_t saved;
      VpiContext() : saved(vpi_mode_flag) { if (saved == VPI_MODE_NONE) vpi_mode_flag = VPI_MODE_CALLTF; }
      ~VpiContext() { vpi_mode_flag = saved; }
};

const unsigned MAX_ARRAYS = 16;
const unsigned MAX_WORDS = 4096;
const unsigned MAX_DELTAS = 50000;
const size_t MAX_JSON_BYTES = 4u * 1024u * 1024u;
const unsigned long STEP_EVENT_CAP = 200000;
const unsigned FULL_SNAPSHOT_WORDS = 64;
const char MEM_TRACE_PATH[] = "/work/.datapath_mem.json";
const char SESSION_STATE_PATH[] = "/work/.session_state.json";

struct Delta {
      uint64_t time;
      int index;
      std::string value;
};

struct TrackedArray {
      vpiHandle handle;
      std::string path;
      int width;
      int size;
      int left;
      int right;
      std::vector<std::pair<int, std::string>> init;
      std::vector<Delta> deltas;
};

std::vector<TrackedArray> arrays;
size_t delta_count = 0;
bool deltas_truncated = false;
bool init_taken = false;
bool live_session = false;
bool session_open = false;

void json_escape(std::string&out, const std::string&text)
{
      out += '"';
      for (char ch : text) {
	    if (ch == '"' || ch == '\\') { out += '\\'; out += ch; }
	    else if ((unsigned char)ch < 0x20) {
		  char buf[8];
		  snprintf(buf, sizeof buf, "\\u%04x", (unsigned char)ch);
		  out += buf;
	    } else out += ch;
      }
      out += '"';
}

int range_value(vpiHandle array, int code)
{
      vpiHandle bound = vpi_handle(code, array);
      if (!bound) return 0;
      s_vpi_value value;
      value.format = vpiIntVal;
      vpi_get_value(bound, &value);
      return value.value.integer;
}

/* Hex digits of one word, or an empty string when unreadable. */
std::string word_hex(vpiHandle array, int index)
{
      vpiHandle word = vpi_handle_by_index(array, index);
      if (!word) return std::string();
      s_vpi_value value;
      value.format = vpiHexStrVal;
      vpi_get_value(word, &value);
      std::string text = (value.format == vpiHexStrVal && value.value.str) ? value.value.str : "";
      for (char&ch : text) if (ch >= 'A' && ch <= 'Z') ch = ch - 'A' + 'a';
      return text;
}

bool is_zero_or_unknown(const std::string&hex)
{
      for (char ch : hex) if (ch != '0' && ch != 'x' && ch != 'z') return false;
      return true;
}

std::string timescale_text()
{
      static const char*units[] = { "s", "ms", "us", "ns", "ps", "fs" };
      int exponent = vpi_get(vpiTimePrecision, 0);
      int magnitude = -exponent;
      if (magnitude < 0) magnitude = 0;
      if (magnitude > 15) magnitude = 15;
      int unit = (magnitude + 2) / 3;
      int scale = unit * 3 - magnitude;   // 0, 1 or 2 -> 1, 10, 100
      std::string text = scale == 2 ? "100" : scale == 1 ? "10" : "1";
      return text + units[unit];
}

/* Collect reg arrays under `scope`, depth first, in declaration order. */
void discover_arrays(vpiHandle scope, std::vector<vpiHandle>&found)
{
      if (found.size() >= MAX_ARRAYS) return;
      if (vpiHandle iter = vpi_iterate(vpiMemory, scope)) {
	    while (vpiHandle array = vpi_scan(iter)) {
		  if (found.size() >= MAX_ARRAYS) { vpi_free_object(iter); break; }
		  int size = vpi_get(vpiSize, array);
		  if (size <= 0 || size > (int)MAX_WORDS) continue;
		  vpiHandle first = vpi_handle_by_index(array, range_value(array, vpiLeftRange));
		  if (!first || vpi_get(vpiType, first) == vpiRealVar) continue;
		  found.push_back(array);
	    }
      }
      if (vpiHandle iter = vpi_iterate(vpiInternalScope, scope)) {
	    while (vpiHandle child = vpi_scan(iter)) {
		  int type = vpi_get(vpiType, child);
		  if (type == vpiFunction || type == vpiTask) continue;
		  discover_arrays(child, found);
	    }
      }
}

std::vector<vpiHandle> design_arrays()
{
      std::vector<vpiHandle> found;
      if (vpiHandle iter = vpi_iterate(vpiModule, 0)) {
	    while (vpiHandle top = vpi_scan(iter)) discover_arrays(top, found);
      }
      return found;
}

TrackedArray describe(vpiHandle array)
{
      TrackedArray info;
      info.handle = array;
      const char*name = vpi_get_str(vpiFullName, array);
      info.path = name ? name : "?";
      info.size = vpi_get(vpiSize, array);
      info.left = range_value(array, vpiLeftRange);
      info.right = range_value(array, vpiRightRange);
      vpiHandle first = vpi_handle_by_index(array, info.left);
      info.width = first ? vpi_get(vpiSize, first) : 0;
      return info;
}

int low_index(const TrackedArray&array) { return array.left < array.right ? array.left : array.right; }

/* Words worth reporting: every word of small arrays, non-zero words of large ones. */
template <typename F> void for_each_reported_word(const TrackedArray&array, F emit)
{
      bool full = array.size <= (int)FULL_SNAPSHOT_WORDS;
      int low = low_index(array);
      for (int offset = 0; offset < array.size; offset += 1) {
	    int index = low + offset;
	    std::string hex = word_hex(array.handle, index);
	    if (hex.empty()) continue;
	    if (!full && is_zero_or_unknown(hex)) continue;
	    emit(index, hex);
      }
}

void append_array_meta(std::string&out, const TrackedArray&array)
{
      out += "{\"path\":";
      json_escape(out, array.path);
      out += ",\"width\":" + std::to_string(array.width);
      out += ",\"size\":" + std::to_string(array.size);
      out += ",\"left\":" + std::to_string(array.left);
      out += ",\"right\":" + std::to_string(array.right);
}

bool write_file(const char*path, const std::string&text)
{
      FILE*file = fopen(path, "w");
      if (!file) return false;
      bool ok = fwrite(text.data(), 1, text.size(), file) == text.size();
      return fclose(file) == 0 && ok;
}

/* ------------------------------------------------------------ batch capture */

void take_init_snapshot()
{
      if (init_taken) return;
      init_taken = true;
      for (TrackedArray&array : arrays)
	    for_each_reported_word(array, [&](int index, const std::string&hex) { array.init.emplace_back(index, hex); });
}

PLI_INT32 on_next_sim_time(p_cb_data)
{
      take_init_snapshot();
      return 0;
}

PLI_INT32 on_word_change(p_cb_data data)
{
      if (!init_taken) return 0;            // time-0 writes are part of the initial snapshot
      TrackedArray&array = arrays[(size_t)(intptr_t)data->user_data];
      if (delta_count >= MAX_DELTAS) { deltas_truncated = true; return 0; }
      std::string hex = data->value && data->value->format == vpiHexStrVal && data->value->value.str
	    ? data->value->value.str : word_hex(array.handle, data->index);
      for (char&ch : hex) if (ch >= 'A' && ch <= 'Z') ch = ch - 'A' + 'a';
      array.deltas.push_back(Delta{ schedule_simtime(), data->index, hex });
      delta_count += 1;
      return 0;
}

void start_capture()
{
      std::vector<vpiHandle> found = design_arrays();
      for (vpiHandle handle : found) {
	    arrays.push_back(describe(handle));
	    s_vpi_value value_format;
	    value_format.format = vpiHexStrVal;
	    s_vpi_time time_format;
	    time_format.type = vpiSuppressTime;
	    s_cb_data cb;
	    memset(&cb, 0, sizeof cb);
	    cb.reason = cbValueChange;
	    cb.cb_rtn = on_word_change;
	    cb.obj = handle;
	    cb.time = &time_format;
	    cb.value = &value_format;
	    cb.user_data = (PLI_BYTE8*)(intptr_t)(arrays.size() - 1);
	    vpi_register_cb(&cb);
      }
      if (arrays.empty()) return;
      s_vpi_time time_format;
      time_format.type = vpiSimTime;
      time_format.high = time_format.low = 0;
      s_cb_data cb;
      memset(&cb, 0, sizeof cb);
      cb.reason = cbNextSimTime;
      cb.cb_rtn = on_next_sim_time;
      cb.time = &time_format;
      vpi_register_cb(&cb);
}

void write_mem_trace()
{
      if (arrays.empty()) return;
      take_init_snapshot();
      std::string out = "{\"timescale\":";
      json_escape(out, timescale_text());
      out += ",\"arrays\":[";
      bool size_capped = false;
      for (size_t a = 0; a < arrays.size(); a += 1) {
	    const TrackedArray&array = arrays[a];
	    if (a) out += ',';
	    append_array_meta(out, array);
	    out += ",\"init\":{";
	    for (size_t i = 0; i < array.init.size(); i += 1) {
		  if (i) out += ',';
		  out += '"' + std::to_string(array.init[i].first) + "\":";
		  json_escape(out, array.init[i].second);
	    }
	    out += "},\"deltas\":[";
	    for (size_t d = 0; d < array.deltas.size(); d += 1) {
		  if (out.size() > MAX_JSON_BYTES) { size_capped = true; break; }
		  const Delta&delta = array.deltas[d];
		  if (d) out += ',';
		  out += '[' + std::to_string(delta.time) + ',' + std::to_string(delta.index) + ',';
		  json_escape(out, delta.value);
		  out += ']';
	    }
	    out += "]}";
      }
      out += "],\"truncated\":";
      out += (deltas_truncated || size_capped) ? "true" : "false";
      out += "}";
      write_file(MEM_TRACE_PATH, out);
}

/* ------------------------------------------------------------ live session */

struct LiveSignal {
      vpiHandle handle;
      std::string path;
};
std::vector<LiveSignal> live_signals;

void discover_signals(vpiHandle scope)
{
      static const int kinds[] = { vpiReg, vpiNet, vpiIntegerVar };
      for (int kind : kinds) {
	    if (vpiHandle iter = vpi_iterate(kind, scope)) {
		  while (vpiHandle signal = vpi_scan(iter)) {
			const char*name = vpi_get_str(vpiFullName, signal);
			if (name) live_signals.push_back(LiveSignal{ signal, name });
		  }
	    }
      }
}

int write_session_state()
{
      std::string out = "{\"time\":" + std::to_string(schedule_simtime());
      out += ",\"timescale\":";
      json_escape(out, timescale_text());
      out += ",\"finished\":";
      out += schedule_finished() ? "true" : "false";
      out += ",\"signals\":{";
      for (size_t i = 0; i < live_signals.size(); i += 1) {
	    s_vpi_value value;
	    value.format = vpiBinStrVal;
	    vpi_get_value(live_signals[i].handle, &value);
	    if (i) out += ',';
	    json_escape(out, live_signals[i].path);
	    out += ':';
	    json_escape(out, value.value.str ? value.value.str : "");
      }
      out += "},\"arrays\":[";
      for (size_t a = 0; a < arrays.size(); a += 1) {
	    if (a) out += ',';
	    append_array_meta(out, arrays[a]);
	    out += ",\"words\":{";
	    bool first = true;
	    for_each_reported_word(arrays[a], [&](int index, const std::string&hex) {
		  if (!first) out += ',';
		  first = false;
		  out += '"' + std::to_string(index) + "\":";
		  json_escape(out, hex);
	    });
	    out += "}}";
      }
      out += "]}";
      return write_file(SESSION_STATE_PATH, out) ? 0 : -1;
}

int step_result(int reason)
{
      VpiContext context;
      if (write_session_state()) return -1;
      if (schedule_finished()) return 1;
      return reason == 2 ? -1 : 0;
}

} // namespace

/* Hooks called from schedule_sim_begin() / schedule_sim_end(). */
void vvp_live_start_of_sim(void)
{
      if (live_session) return;
      VpiContext context;
      start_capture();
}

void vvp_live_end_of_sim(void)
{
      if (live_session) return;
      VpiContext context;
      write_mem_trace();
}

extern "C" {

/*
 * Load a compiled design, settle time 0 and write the initial state.
 * Returns 0, 1 when the design already finished, or -1 on error.
 */
int vvp_session_open(const char*vvp_path)
{
      if (session_open || !vvp_path) return -1;
      live_session = true;
      vvp_set_stop_is_finish(true, 0);
      static char path_arg[512];
      snprintf(path_arg, sizeof path_arg, "%s", vvp_path);
      char*argv[] = { path_arg, 0 };
      vvp_init(0, 1, argv);
      if (vvp_live_load(vvp_path)) return -1;
      schedule_sim_begin();
      session_open = true;
      {
	    VpiContext context;
	    if (vpiHandle iter = vpi_iterate(vpiModule, 0)) {
		  while (vpiHandle top = vpi_scan(iter)) discover_signals(top);
	    }
	    for (vpiHandle handle : design_arrays()) arrays.push_back(describe(handle));
      }
      return step_result(schedule_sim_run(true, schedule_simtime(), STEP_EVENT_CAP));
}

/* Drive a reg by full hierarchical name with a binary string. Returns 0 or -1. */
int vvp_session_set(const char*signal_path, const char*bin_str)
{
      if (!session_open || !signal_path || !bin_str) return -1;
      VpiContext context;
      vpiHandle signal = vpi_handle_by_name(signal_path, 0);
      if (!signal) return -1;
      for (const char*cur = bin_str; *cur; cur += 1)
	    if (!strchr("01xzXZ", *cur)) return -1;
      s_vpi_value value;
      value.format = vpiBinStrVal;
      value.value.str = const_cast<char*>(bin_str);
      vpi_put_value(signal, &value, 0, vpiNoDelay);
      return 0;
}

/*
 * Advance up to `delta_ticks` (0 drains the current time step). Returns 0,
 * 1 when the design called $finish, or -1 on error / event cap.
 */
int vvp_session_step(int delta_ticks)
{
      if (!session_open || delta_ticks < 0) return -1;
      if (schedule_finished()) return step_result(0);
      uint64_t limit = schedule_simtime() + (uint64_t)delta_ticks;
      return step_result(schedule_sim_run(true, limit, STEP_EVENT_CAP));
}

/* Run final blocks and end-of-simulation callbacks. */
int vvp_session_close(void)
{
      if (!session_open) return -1;
      session_open = false;
      schedule_sim_end();
      return 0;
}

}
