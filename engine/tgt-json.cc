/*
 * Datapath Studio schematic target for ivl (selected with flag DLL=json.tgt).
 *
 * Writes the elaborated, synthesized (synth/synth2) design as Yosys-style
 * JSON so the browser can lay it out as an RTL schematic:
 *
 *   { "creator": ..., "modules": { "<name>": { "attributes", "ports", "cells", "netnames" } } }
 *
 * Every nexus gets a run of integer bit ids. Wiring-only devices (buffers,
 * part selects, concatenations, sign extension, repeats) are folded away by
 * uniting bits, so ports, nets and cell pins share ids. Constant drivers
 * become Yosys "0"/"1"/"x"/"z" bits. Each module scope instance becomes a
 * module; parents reference it with an instance cell. Processes synth2 could
 * not turn into logic (kept by flag SCHEMATIC_NONFATAL) become $mem blocks
 * when they write arrays, otherwise $proc blocks.
 *
 * Copyright (c) 2026 Datapath Studio contributors
 * This source is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 */

# include  "ivl_target.h"
# include  <algorithm>
# include  <cstdio>
# include  <cstring>
# include  <map>
# include  <set>
# include  <string>
# include  <vector>

namespace {

/* ------------------------------------------------------------ bits */

std::vector<int> parent;
std::vector<char> constant;              // per bit: 0 or '0','1','x','z'
std::map<ivl_nexus_t, std::pair<int, unsigned>> nexus_bits;   // nexus -> (first bit, width)

int find(int bit)
{
      while (parent[bit] != bit) { parent[bit] = parent[parent[bit]]; bit = parent[bit]; }
      return bit;
}

void unite(int a, int b)
{
      a = find(a); b = find(b);
      if (a == b) return;
      parent[b] = a;
      if (!constant[a]) constant[a] = constant[b];
}

unsigned nexus_width(ivl_nexus_t nex)
{
      unsigned lpm_width = 0;
      for (unsigned idx = 0; idx < ivl_nexus_ptrs(nex); idx += 1) {
	    ivl_nexus_ptr_t ptr = ivl_nexus_ptr(nex, idx);
	    if (ivl_signal_t sig = ivl_nexus_ptr_sig(ptr)) return ivl_signal_width(sig);
	    if (ivl_net_const_t con = ivl_nexus_ptr_con(ptr)) return ivl_const_width(con);
	    if (ivl_net_logic_t log = ivl_nexus_ptr_log(ptr)) return ivl_logic_width(log);
	    if (ivl_lpm_t lpm = ivl_nexus_ptr_lpm(ptr)) {
		  if (ivl_lpm_q(lpm) == nex && !lpm_width) {
			ivl_lpm_type_t type = ivl_lpm_type(lpm);
			bool one_bit = type == IVL_LPM_CMP_EQ || type == IVL_LPM_CMP_NE || type == IVL_LPM_CMP_EEQ
			      || type == IVL_LPM_CMP_NEE || type == IVL_LPM_CMP_GT || type == IVL_LPM_CMP_GE
			      || type == IVL_LPM_CMP_EQX || type == IVL_LPM_CMP_EQZ || type == IVL_LPM_CMP_WEQ
			      || type == IVL_LPM_CMP_WNE || (type >= IVL_LPM_RE_AND && type <= IVL_LPM_RE_XOR);
			lpm_width = one_bit ? 1 : ivl_lpm_width(lpm);
		  }
	    }
      }
      return lpm_width ? lpm_width : 1;
}

/* Raw (un-united) bit ids of a nexus, LSB first. */
std::vector<int> bits_of(ivl_nexus_t nex)
{
      std::vector<int> out;
      if (!nex) return out;
      auto found = nexus_bits.find(nex);
      if (found == nexus_bits.end()) {
	    unsigned width = nexus_width(nex);
	    int first = (int)parent.size();
	    for (unsigned idx = 0; idx < width; idx += 1) { parent.push_back(first + idx); constant.push_back(0); }
	    found = nexus_bits.emplace(nex, std::make_pair(first, width)).first;
      }
      for (unsigned idx = 0; idx < found->second.second; idx += 1) out.push_back(found->second.first + idx);
      return out;
}

/* ------------------------------------------------------------ JSON text */

std::string quote(const std::string&text)
{
      std::string out = "\"";
      for (unsigned char ch : text) {
	    if (ch == '"' || ch == '\\') { out += '\\'; out += (char)ch; }
	    else if (ch < 0x20) { char buf[8]; snprintf(buf, sizeof buf, "\\u%04x", ch); out += buf; }
	    else out += (char)ch;
      }
      return out + "\"";
}

std::string bits_json(const std::vector<int>&bits)
{
      std::string out = "[";
      for (size_t idx = 0; idx < bits.size(); idx += 1) {
	    if (idx) out += ",";
	    int root = find(bits[idx]);
	    if (constant[root]) { out += '"'; out += constant[root]; out += '"'; }
	    else out += std::to_string(root + 2);   // Yosys reserves 0 and 1
      }
      return out + "]";
}

bool is_const(const std::vector<int>&bits, char value)
{
      if (bits.empty()) return false;
      for (int bit : bits) if (constant[find(bit)] != value) return false;
      return true;
}

std::string binary32(unsigned long value)
{
      std::string out(32, '0');
      for (int idx = 0; idx < 32; idx += 1) if (value >> idx & 1) out[31 - idx] = '1';
      return out;
}

std::string src_of(const char*file, unsigned line)
{
      if (!file || !*file) return "";
      std::string path = file;
      if (path.rfind("/work/", 0) == 0) path = path.substr(6);
      return path + ":" + std::to_string(line);
}

struct Pin {
      std::string name;
      bool output;
      std::vector<int> bits;
};

struct Cell {
      std::string name;
      std::string type;
      bool hidden = true;
      std::string src;
      std::vector<std::pair<std::string, std::string>> params;   // already JSON-encoded values
      std::vector<Pin> pins;
};

std::string cell_json(const Cell&cell)
{
      std::string out = quote(cell.name) + ":{\"hide_name\":" + (cell.hidden ? "1" : "0") + ",\"type\":" + quote(cell.type);
      out += ",\"parameters\":{";
      for (size_t idx = 0; idx < cell.params.size(); idx += 1) out += (idx ? "," : "") + quote(cell.params[idx].first) + ":" + cell.params[idx].second;
      out += "},\"attributes\":{";
      if (!cell.src.empty()) out += "\"src\":" + quote(cell.src);
      out += "},\"port_directions\":{";
      for (size_t idx = 0; idx < cell.pins.size(); idx += 1) out += (idx ? "," : "") + quote(cell.pins[idx].name) + ":" + (cell.pins[idx].output ? "\"output\"" : "\"input\"");
      out += "},\"connections\":{";
      for (size_t idx = 0; idx < cell.pins.size(); idx += 1) out += (idx ? "," : "") + quote(cell.pins[idx].name) + ":" + bits_json(cell.pins[idx].bits);
      return out + "}}";
}

/* ------------------------------------------------------------ design walk */

std::set<ivl_lpm_t> folded_lpms;
std::set<ivl_net_logic_t> folded_logs;
std::map<ivl_scope_t, std::vector<ivl_process_t>> processes;
std::map<std::string, unsigned> type_count;
std::map<ivl_scope_t, std::string> module_keys;

bool is_module(ivl_scope_t scope) { return ivl_scope_type(scope) == IVL_SCT_MODULE; }

/* Child scopes in declaration order. */
std::vector<ivl_scope_t> children(ivl_scope_t scope)
{
      std::vector<ivl_scope_t> out;
      for (size_t idx = 0; idx < ivl_scope_childs(scope); idx += 1) out.push_back(ivl_scope_child(scope, idx));
      return out;
}

/* The scope itself plus nested generate/begin/fork scopes, stopping at child modules. */
void body_scopes(ivl_scope_t scope, std::vector<ivl_scope_t>&out, bool root = true)
{
      ivl_scope_type_t type = ivl_scope_type(scope);
      if (!root && (type == IVL_SCT_MODULE || type == IVL_SCT_FUNCTION || type == IVL_SCT_TASK || type == IVL_SCT_CLASS || type == IVL_SCT_PACKAGE)) return;
      out.push_back(scope);
      for (ivl_scope_t child : children(scope)) body_scopes(child, out, false);
}

void count_types(ivl_scope_t scope)
{
      if (is_module(scope)) type_count[ivl_scope_tname(scope)] += 1;
      for (ivl_scope_t child : children(scope)) count_types(child);
}

std::string module_key(ivl_scope_t scope)
{
      auto found = module_keys.find(scope);
      if (found != module_keys.end()) return found->second;
      std::string tname = ivl_scope_tname(scope);
      std::string key = type_count[tname] > 1 ? "$paramod\\" + tname + "\\" + ivl_scope_name(scope) : tname;
      module_keys[scope] = key;
      return key;
}

/* Value of an all-0/1 constant bit vector (LSB first); -1 when not constant or negative. */
long constant_value(const std::vector<int>&bits, bool is_signed)
{
      if (bits.empty()) return -1;
      long value = 0;
      for (size_t bit = 0; bit < bits.size(); bit += 1) {
	    char ch = constant[find(bits[bit])];
	    if (ch != '0' && ch != '1') return -1;
	    if (ch == '1') {
		  if (bit >= 30 || (is_signed && bit == bits.size() - 1)) return -1;   // huge or negative
		  value |= 1L << bit;
	    }
      }
      return value;
}

/* Fold wiring-only devices and constants into the bit equivalence classes. */
void fold_scope(ivl_scope_t scope)
{
      for (unsigned idx = 0; idx < ivl_scope_logs(scope); idx += 1) {
	    ivl_net_logic_t log = ivl_scope_log(scope, idx);
	    ivl_logic_t type = ivl_logic_type(log);
	    if ((type == IVL_LO_BUF || type == IVL_LO_BUFZ || type == IVL_LO_BUFT) && ivl_logic_pins(log) == 2) {
		  std::vector<int> out = bits_of(ivl_logic_pin(log, 0)), in = bits_of(ivl_logic_pin(log, 1));
		  for (size_t bit = 0; bit < std::min(out.size(), in.size()); bit += 1) unite(in[bit], out[bit]);
		  folded_logs.insert(log);
	    } else if (type == IVL_LO_PULLUP || type == IVL_LO_PULLDOWN) {
		  for (int bit : bits_of(ivl_logic_pin(log, 0))) { int root = find(bit); if (!constant[root]) constant[root] = type == IVL_LO_PULLUP ? '1' : '0'; }
		  folded_logs.insert(log);
	    }
      }
      for (unsigned idx = 0; idx < ivl_scope_lpms(scope); idx += 1) {
	    ivl_lpm_t lpm = ivl_scope_lpm(scope, idx);
	    ivl_lpm_type_t type = ivl_lpm_type(lpm);
	    std::vector<int> q = bits_of(ivl_lpm_q(lpm));
	    if ((type == IVL_LPM_PART_VP || type == IVL_LPM_PART_PV) && !ivl_lpm_data(lpm, 1)) {
		  std::vector<int> in = bits_of(ivl_lpm_data(lpm, 0));
		  unsigned base = ivl_lpm_base(lpm), width = ivl_lpm_width(lpm);
		  for (unsigned bit = 0; bit < width; bit += 1) {
			if (type == IVL_LPM_PART_VP && base + bit < in.size() && bit < q.size()) unite(in[base + bit], q[bit]);
			if (type == IVL_LPM_PART_PV && bit < in.size() && base + bit < q.size()) unite(in[bit], q[base + bit]);
		  }
		  folded_lpms.insert(lpm);
	    } else if (type == IVL_LPM_CONCAT || type == IVL_LPM_CONCATZ) {
		  size_t offset = 0;
		  for (unsigned input = 0; input < ivl_lpm_size(lpm); input += 1) {
			for (int bit : bits_of(ivl_lpm_data(lpm, input))) { if (offset < q.size()) unite(bit, q[offset]); offset += 1; }
		  }
		  folded_lpms.insert(lpm);
	    } else if (type == IVL_LPM_SIGN_EXT) {
		  std::vector<int> in = bits_of(ivl_lpm_data(lpm, 0));
		  for (size_t bit = 0; bit < q.size() && !in.empty(); bit += 1) unite(in[std::min(bit, in.size() - 1)], q[bit]);
		  folded_lpms.insert(lpm);
	    } else if (type == IVL_LPM_REPEAT) {
		  std::vector<int> in = bits_of(ivl_lpm_data(lpm, 0));
		  for (size_t bit = 0; bit < q.size() && !in.empty(); bit += 1) unite(in[bit % in.size()], q[bit]);
		  folded_lpms.insert(lpm);
	    }
      }
      for (ivl_scope_t child : children(scope)) fold_scope(child);
}

/* Variable bit/part selects whose index is constant once wiring is folded (e.g. unrolled
   loops) become plain aliases: the select value is the bit offset; bits outside read as x.
   Returns how many selects were folded. */
unsigned fold_constant_selects(ivl_scope_t scope)
{
      unsigned folded = 0;
      for (unsigned idx = 0; idx < ivl_scope_lpms(scope); idx += 1) {
	    ivl_lpm_t lpm = ivl_scope_lpm(scope, idx);
	    if (ivl_lpm_type(lpm) != IVL_LPM_PART_VP || folded_lpms.count(lpm) || !ivl_lpm_data(lpm, 1)) continue;
	    long base = constant_value(bits_of(ivl_lpm_data(lpm, 1)), ivl_lpm_signed(lpm));
	    if (base < 0) continue;
	    std::vector<int> q = bits_of(ivl_lpm_q(lpm)), in = bits_of(ivl_lpm_data(lpm, 0));
	    for (size_t bit = 0; bit < q.size(); bit += 1) {
		  if ((size_t)base + bit < in.size()) unite(in[base + bit], q[bit]);
		  else { int root = find(q[bit]); if (!constant[root]) constant[root] = 'x'; }
	    }
	    folded_lpms.insert(lpm);
	    folded += 1;
      }
      for (ivl_scope_t child : children(scope)) folded += fold_constant_selects(child);
      return folded;
}

const char*gate_type(ivl_logic_t type)
{
      switch (type) {
	  case IVL_LO_AND: return "$and";
	  case IVL_LO_OR: return "$or";
	  case IVL_LO_XOR: return "$xor";
	  case IVL_LO_NAND: return "$nand";
	  case IVL_LO_NOR: return "$nor";
	  case IVL_LO_XNOR: return "$xnor";
	  case IVL_LO_NOT: return "$not";
	  case IVL_LO_BUF: case IVL_LO_BUFZ: case IVL_LO_BUFT: return "$buf";
	  case IVL_LO_BUFIF0: case IVL_LO_BUFIF1: case IVL_LO_NOTIF0: case IVL_LO_NOTIF1: return "$tribuf";
	  case IVL_LO_UDP: return "$udp";
	  default: return "$logic";
      }
}

const char*lpm_cell_type(ivl_lpm_t lpm)
{
      switch (ivl_lpm_type(lpm)) {
	  case IVL_LPM_ADD: return "$add";
	  case IVL_LPM_SUB: return "$sub";
	  case IVL_LPM_MULT: return "$mul";
	  case IVL_LPM_DIVIDE: return "$div";
	  case IVL_LPM_MOD: return "$mod";
	  case IVL_LPM_POW: return "$pow";
	  case IVL_LPM_ABS: return "$abs";
	  case IVL_LPM_CMP_EQ: case IVL_LPM_CMP_WEQ: return "$eq";
	  case IVL_LPM_CMP_NE: case IVL_LPM_CMP_WNE: return "$ne";
	  case IVL_LPM_CMP_EEQ: case IVL_LPM_CMP_EQX: case IVL_LPM_CMP_EQZ: return "$eqx";
	  case IVL_LPM_CMP_NEE: return "$nex";
	  case IVL_LPM_CMP_GT: return "$gt";
	  case IVL_LPM_CMP_GE: return "$ge";
	  case IVL_LPM_SHIFTL: return "$shl";
	  case IVL_LPM_SHIFTR: return ivl_lpm_signed(lpm) ? "$sshr" : "$shr";
	  case IVL_LPM_RE_AND: return "$reduce_and";
	  case IVL_LPM_RE_OR: return "$reduce_or";
	  case IVL_LPM_RE_XOR: return "$reduce_xor";
	  case IVL_LPM_RE_NAND: return "$reduce_nand";
	  case IVL_LPM_RE_NOR: return "$reduce_nor";
	  case IVL_LPM_RE_XNOR: return "$reduce_xnor";
	  case IVL_LPM_UFUNC: return "$func";
	  case IVL_LPM_SFUNC: return "$sfunc";
	  case IVL_LPM_SUBSTITUTE: return "$substitute";
	  case IVL_LPM_CAST_INT: case IVL_LPM_CAST_INT2: case IVL_LPM_CAST_REAL: return "$cast";
	  case IVL_LPM_PART_VP: return "$shiftx";
	  case IVL_LPM_PART_PV: return "$part";
	  default: return "$lpm";
      }
}

/* ---- behavioural blocks (unsynthesized processes) ---- */

struct ProcInfo {
      std::set<ivl_signal_t> reads, writes, addr, cond, arrays_written, arrays_read;
      std::vector<ivl_nexus_t> clocks;
};

void expr_reads(ivl_expr_t expr, std::set<ivl_signal_t>&into, ProcInfo&info)
{
      if (!expr) return;
      switch (ivl_expr_type(expr)) {
	  case IVL_EX_SIGNAL: {
		ivl_signal_t sig = ivl_expr_signal(expr);
		if (ivl_signal_array_count(sig) > 1) { info.arrays_read.insert(sig); expr_reads(ivl_expr_oper1(expr), info.addr, info); }
		else into.insert(sig);
		return;
	  }
	  case IVL_EX_BINARY: case IVL_EX_SELECT:
		expr_reads(ivl_expr_oper1(expr), into, info); expr_reads(ivl_expr_oper2(expr), into, info); return;
	  case IVL_EX_UNARY:
		expr_reads(ivl_expr_oper1(expr), into, info); return;
	  case IVL_EX_TERNARY:
		expr_reads(ivl_expr_oper1(expr), info.cond, info); expr_reads(ivl_expr_oper2(expr), into, info); expr_reads(ivl_expr_oper3(expr), into, info); return;
	  case IVL_EX_CONCAT: case IVL_EX_SFUNC: case IVL_EX_UFUNC:
		for (unsigned idx = 0; idx < ivl_expr_parms(expr); idx += 1) expr_reads(ivl_expr_parm(expr, idx), into, info);
		return;
	  default:
		return;
      }
}

void stmt_walk(ivl_statement_t stmt, ProcInfo&info)
{
      if (!stmt) return;
      switch (ivl_statement_type(stmt)) {
	  case IVL_ST_ASSIGN: case IVL_ST_ASSIGN_NB:
		for (unsigned idx = 0; idx < ivl_stmt_lvals(stmt); idx += 1) {
		      ivl_lval_t lval = ivl_stmt_lval(stmt, idx);
		      while (lval && !ivl_lval_sig(lval) && ivl_lval_nest(lval)) lval = ivl_lval_nest(lval);
		      ivl_signal_t sig = lval ? ivl_lval_sig(lval) : 0;
		      if (!sig) continue;
		      if (ivl_signal_array_count(sig) > 1) { info.arrays_written.insert(sig); expr_reads(ivl_lval_idx(lval), info.addr, info); }
		      else info.writes.insert(sig);
		      expr_reads(ivl_lval_part_off(lval), info.addr, info);
		}
		expr_reads(ivl_stmt_rval(stmt), info.reads, info);
		return;
	  case IVL_ST_BLOCK: case IVL_ST_FORK: case IVL_ST_FORK_JOIN_ANY: case IVL_ST_FORK_JOIN_NONE:
		for (unsigned idx = 0; idx < ivl_stmt_block_count(stmt); idx += 1) stmt_walk(ivl_stmt_block_stmt(stmt, idx), info);
		return;
	  case IVL_ST_CONDIT:
		expr_reads(ivl_stmt_cond_expr(stmt), info.cond, info);
		stmt_walk(ivl_stmt_cond_true(stmt), info);
		stmt_walk(ivl_stmt_cond_false(stmt), info);
		return;
	  case IVL_ST_CASE: case IVL_ST_CASEX: case IVL_ST_CASEZ: case IVL_ST_CASER:
		expr_reads(ivl_stmt_cond_expr(stmt), info.cond, info);
		for (unsigned idx = 0; idx < ivl_stmt_case_count(stmt); idx += 1) stmt_walk(ivl_stmt_case_stmt(stmt, idx), info);
		return;
	  case IVL_ST_WAIT:
		for (unsigned idx = 0; idx < ivl_stmt_nevent(stmt); idx += 1) {
		      ivl_event_t event = ivl_stmt_events(stmt, idx);
		      for (unsigned edge = 0; edge < ivl_event_npos(event); edge += 1) info.clocks.push_back(ivl_event_pos(event, edge));
		      for (unsigned edge = 0; edge < ivl_event_nneg(event); edge += 1) info.clocks.push_back(ivl_event_neg(event, edge));
		}
		stmt_walk(ivl_stmt_sub_stmt(stmt), info);
		return;
	  case IVL_ST_DELAY: case IVL_ST_DELAYX: case IVL_ST_FOREVER:
		stmt_walk(ivl_stmt_sub_stmt(stmt), info);
		return;
	  case IVL_ST_REPEAT: case IVL_ST_WHILE: case IVL_ST_DO_WHILE:
		expr_reads(ivl_stmt_cond_expr(stmt), info.cond, info);
		stmt_walk(ivl_stmt_sub_stmt(stmt), info);
		return;
	  case IVL_ST_FORLOOP:
		stmt_walk(ivl_stmt_init_stmt(stmt), info);
		expr_reads(ivl_stmt_cond_expr(stmt), info.cond, info);
		stmt_walk(ivl_stmt_sub_stmt(stmt), info);
		stmt_walk(ivl_stmt_step_stmt(stmt), info);
		return;
	  default:
		return;
      }
}

int collect_process(ivl_process_t proc, void*)
{
      ivl_process_type_t type = ivl_process_type(proc);
      if (type == IVL_PR_INITIAL || type == IVL_PR_FINAL || ivl_process_analog(proc)) return 0;
      ivl_scope_t scope = ivl_process_scope(proc);
      while (scope && !is_module(scope)) scope = ivl_scope_parent(scope);
      if (scope) processes[scope].push_back(proc);
      return 0;
}

std::vector<int> signals_bits(const std::set<ivl_signal_t>&signals, const std::set<ivl_signal_t>&skip = {})
{
      std::vector<ivl_signal_t> ordered(signals.begin(), signals.end());
      std::sort(ordered.begin(), ordered.end(), [](ivl_signal_t a, ivl_signal_t b) { return strcmp(ivl_signal_name(a), ivl_signal_name(b)) < 0; });
      std::vector<int> out;
      for (ivl_signal_t sig : ordered) {
	    if (skip.count(sig)) continue;
	    for (int bit : bits_of(ivl_signal_nex(sig, 0))) out.push_back(bit);
      }
      return out;
}

std::string local_name(ivl_scope_t module, const char*full)
{
      std::string prefix = std::string(ivl_scope_name(module)) + ".";
      std::string name = full;
      return name.rfind(prefix, 0) == 0 ? name.substr(prefix.size()) : name;
}

/* ------------------------------------------------------------ module emission */

std::string emit_module(ivl_scope_t module, bool top)
{
      std::vector<ivl_scope_t> body;
      body_scopes(module, body);
      std::vector<Cell> cells;
      std::set<std::string> used;
      auto unique = [&](std::string name) {
	    std::string base = name; unsigned n = 1;
	    while (used.count(name)) name = base + "$" + std::to_string(n++);
	    used.insert(name);
	    return name;
      };
      auto in = [](const char*name, ivl_nexus_t nex) { return Pin{ name, false, bits_of(nex) }; };
      auto out = [](const char*name, ivl_nexus_t nex) { return Pin{ name, true, bits_of(nex) }; };

      // Memories: writers (processes) and readers (IVL_LPM_ARRAY) of the same array share one $mem cell.
      std::map<ivl_signal_t, Cell> memories;
      auto memory = [&](ivl_signal_t sig) -> Cell& {
	    auto found = memories.find(sig);
	    if (found != memories.end()) return found->second;
	    Cell cell;
	    cell.name = local_name(module, ivl_signal_name(sig));
	    cell.type = "$mem";
	    cell.hidden = false;
	    cell.src = src_of(ivl_signal_file(sig), ivl_signal_lineno(sig));
	    cell.params = { { "MEMID", quote(cell.name) }, { "WIDTH", quote(binary32(ivl_signal_width(sig))) }, { "SIZE", quote(binary32(ivl_signal_array_count(sig))) }, { "OFFSET", quote(binary32((unsigned)ivl_signal_array_base(sig))) } };
	    return memories.emplace(sig, cell).first->second;
      };

      for (ivl_scope_t scope : body) {
	    for (unsigned idx = 0; idx < ivl_scope_logs(scope); idx += 1) {
		  ivl_net_logic_t log = ivl_scope_log(scope, idx);
		  if (folded_logs.count(log)) continue;
		  Cell cell;
		  cell.type = gate_type(ivl_logic_type(log));
		  cell.name = unique(std::string("$") + (cell.type.c_str() + 1) + "$" + src_of(ivl_logic_file(log), ivl_logic_lineno(log)) + "$" + ivl_logic_basename(log));
		  cell.src = src_of(ivl_logic_file(log), ivl_logic_lineno(log));
		  unsigned pins = ivl_logic_pins(log);
		  for (unsigned pin = 1; pin < pins; pin += 1) {
			std::string name = pins == 2 ? "A" : std::string(1, (char)('A' + std::min(pin - 1, 25u)));
			cell.pins.push_back(Pin{ name, false, bits_of(ivl_logic_pin(log, pin)) });
		  }
		  cell.pins.push_back(out("Y", ivl_logic_pin(log, 0)));
		  cell.params.push_back({ "WIDTH", quote(binary32(ivl_logic_width(log))) });
		  cells.push_back(cell);
	    }
	    for (unsigned idx = 0; idx < ivl_scope_lpms(scope); idx += 1) {
		  ivl_lpm_t lpm = ivl_scope_lpm(scope, idx);
		  if (folded_lpms.count(lpm)) continue;
		  ivl_lpm_type_t type = ivl_lpm_type(lpm);
		  std::string src = src_of(ivl_lpm_file(lpm), ivl_lpm_lineno(lpm));
		  if (type == IVL_LPM_ARRAY) {
			Cell&mem = memory(ivl_lpm_array(lpm));
			unsigned port = 0;
			for (const Pin&pin : mem.pins) if (pin.name.rfind("RD_DATA", 0) == 0) port += 1;
			mem.pins.push_back(Pin{ "RD_ADDR" + std::to_string(port), false, bits_of(ivl_lpm_select(lpm)) });
			mem.pins.push_back(Pin{ "RD_DATA" + std::to_string(port), true, bits_of(ivl_lpm_q(lpm)) });
			continue;
		  }
		  Cell cell;
		  cell.src = src;
		  cell.params.push_back({ "WIDTH", quote(binary32(ivl_lpm_width(lpm))) });
		  if (type == IVL_LPM_FF) {
			bool async = ivl_lpm_async_clr(lpm) || ivl_lpm_async_set(lpm);
			bool sync = ivl_lpm_sync_clr(lpm) || ivl_lpm_sync_set(lpm);
			// synth2 gives every flip-flop an enable; a constant-1 enable is just a plain register.
			ivl_nexus_t enable = ivl_lpm_enable(lpm);
			if (enable && is_const(bits_of(enable), '1')) enable = 0;
			cell.type = std::string(async ? "$adff" : sync ? "$sdff" : "$dff") + (enable ? "e" : "");
			cell.params.push_back({ "CLK_POLARITY", quote(binary32(ivl_lpm_negedge(lpm) ? 0 : 1)) });
			cell.pins.push_back(in("CLK", ivl_lpm_clk(lpm)));
			cell.pins.push_back(in("D", ivl_lpm_data(lpm, 0)));
			if (enable) cell.pins.push_back(in("EN", enable));
			if (ivl_lpm_async_clr(lpm)) cell.pins.push_back(in("ARST", ivl_lpm_async_clr(lpm)));
			if (ivl_lpm_async_set(lpm)) cell.pins.push_back(in("ASET", ivl_lpm_async_set(lpm)));
			if (ivl_lpm_sync_clr(lpm)) cell.pins.push_back(in("SRST", ivl_lpm_sync_clr(lpm)));
			if (ivl_lpm_sync_set(lpm)) cell.pins.push_back(in("SSET", ivl_lpm_sync_set(lpm)));
			cell.pins.push_back(out("Q", ivl_lpm_q(lpm)));
		  } else if (type == IVL_LPM_LATCH) {
			cell.type = "$dlatch";
			cell.pins.push_back(in("EN", ivl_lpm_enable(lpm)));
			cell.pins.push_back(in("D", ivl_lpm_data(lpm, 0)));
			cell.pins.push_back(out("Q", ivl_lpm_q(lpm)));
		  } else if (type == IVL_LPM_MUX) {
			unsigned size = ivl_lpm_size(lpm);
			cell.type = size == 2 ? "$mux" : "$pmux";
			for (unsigned input = 0; input < size; input += 1) {
			      std::string name = size == 2 ? (input ? "B" : "A") : "D" + std::to_string(input);
			      cell.pins.push_back(Pin{ name, false, bits_of(ivl_lpm_data(lpm, input)) });
			}
			cell.pins.push_back(in("S", ivl_lpm_select(lpm)));
			cell.pins.push_back(out("Y", ivl_lpm_q(lpm)));
		  } else {
			cell.type = lpm_cell_type(lpm);
			if (ivl_lpm_signed(lpm)) {
			      cell.params.push_back({ "A_SIGNED", quote(binary32(1)) });
			      cell.params.push_back({ "B_SIGNED", quote(binary32(1)) });
			}
			unsigned inputs = 0;
			switch (type) {
			    case IVL_LPM_RE_AND: case IVL_LPM_RE_OR: case IVL_LPM_RE_XOR: case IVL_LPM_RE_NAND:
			    case IVL_LPM_RE_NOR: case IVL_LPM_RE_XNOR: case IVL_LPM_ABS: case IVL_LPM_CAST_INT:
			    case IVL_LPM_CAST_INT2: case IVL_LPM_CAST_REAL:
				  inputs = 1; break;
			    case IVL_LPM_UFUNC: case IVL_LPM_SFUNC:
				  inputs = ivl_lpm_size(lpm); break;
			    case IVL_LPM_PART_VP: case IVL_LPM_PART_PV:
				  inputs = 2; break;
			    default:
				  inputs = 2;
			}
			for (unsigned input = 0; input < inputs; input += 1) {
			      ivl_nexus_t nex = ivl_lpm_data(lpm, input);
			      if (!nex) continue;
			      std::string name = inputs <= 2 ? std::string(1, (char)('A' + input)) : "A" + std::to_string(input);
			      cell.pins.push_back(Pin{ name, false, bits_of(nex) });
			}
			if (type == IVL_LPM_UFUNC && ivl_lpm_define(lpm)) cell.params.push_back({ "FUNCTION", quote(ivl_scope_tname(ivl_lpm_define(lpm))) });
			if (type == IVL_LPM_SFUNC && ivl_lpm_string(lpm)) cell.params.push_back({ "FUNCTION", quote(ivl_lpm_string(lpm)) });
			cell.pins.push_back(out("Y", ivl_lpm_q(lpm)));
		  }
		  cell.name = unique(cell.type + "$" + src + "$" + (ivl_lpm_basename(lpm) ? ivl_lpm_basename(lpm) : "lpm"));
		  cells.push_back(cell);
	    }
      }

      // Behavioural blocks left in the design.
      for (ivl_process_t proc : processes[module]) {
	    ProcInfo info;
	    stmt_walk(ivl_process_stmt(proc), info);
	    std::string src = src_of(ivl_process_file(proc), ivl_process_lineno(proc));
	    std::set<ivl_signal_t> clock_sigs;
	    ivl_nexus_t clock = info.clocks.empty() ? 0 : info.clocks.front();
	    for (ivl_nexus_t nex : info.clocks)
		  for (unsigned idx = 0; idx < ivl_nexus_ptrs(nex); idx += 1)
			if (ivl_signal_t sig = ivl_nexus_ptr_sig(ivl_nexus_ptr(nex, idx))) clock_sigs.insert(sig);
	    for (ivl_signal_t array : info.arrays_written) {
		  Cell&mem = memory(array);
		  if (std::any_of(mem.pins.begin(), mem.pins.end(), [](const Pin&pin) { return pin.name == "WR_DATA"; })) continue;
		  if (clock) mem.pins.push_back(in("CLK", clock));
		  std::vector<int> addr = signals_bits(info.addr, clock_sigs);
		  if (!addr.empty()) mem.pins.push_back(Pin{ "WR_ADDR", false, addr });
		  std::vector<int> data = signals_bits(info.reads, clock_sigs);
		  if (!data.empty()) mem.pins.push_back(Pin{ "WR_DATA", false, data });
		  std::vector<int> enable = signals_bits(info.cond, clock_sigs);
		  if (!enable.empty()) mem.pins.push_back(Pin{ "WR_EN", false, enable });
	    }
	    if (info.writes.empty()) continue;
	    Cell cell;
	    cell.type = "$proc";
	    cell.src = src;
	    cell.name = unique("$proc$" + src);
	    if (clock) cell.pins.push_back(in("CLK", clock));
	    std::set<ivl_signal_t> inputs;
	    for (const std::set<ivl_signal_t>*group : { &info.cond, &info.addr, &info.reads })
		  for (ivl_signal_t sig : *group) if (!info.writes.count(sig) && !clock_sigs.count(sig)) inputs.insert(sig);
	    std::set<std::string> pin_names = { "CLK" };
	    auto pin_name = [&](ivl_signal_t sig) {
		  std::string name = ivl_signal_basename(sig), base = name; unsigned n = 1;
		  while (pin_names.count(name)) name = base + "_" + std::to_string(n++);
		  pin_names.insert(name);
		  return name;
	    };
	    for (ivl_signal_t sig : inputs) cell.pins.push_back(Pin{ pin_name(sig), false, bits_of(ivl_signal_nex(sig, 0)) });
	    for (ivl_signal_t sig : info.writes) cell.pins.push_back(Pin{ pin_name(sig), true, bits_of(ivl_signal_nex(sig, 0)) });
	    cells.push_back(cell);
      }
      for (auto&entry : memories) { entry.second.name = unique(entry.second.name); cells.push_back(entry.second); }

      // Child module instances.
      for (ivl_scope_t scope : body) {
	    for (ivl_scope_t child : children(scope)) {
		  if (!is_module(child)) continue;
		  Cell cell;
		  cell.type = module_key(child);
		  cell.hidden = false;
		  cell.name = unique(local_name(module, ivl_scope_name(child)));
		  cell.src = src_of(ivl_scope_file(child), ivl_scope_lineno(child));
		  std::vector<ivl_signal_t> ports;
		  for (unsigned idx = 0; idx < ivl_scope_sigs(child); idx += 1) {
			ivl_signal_t sig = ivl_scope_sig(child, idx);
			if (ivl_signal_port(sig) != IVL_SIP_NONE) ports.push_back(sig);
		  }
		  std::stable_sort(ports.begin(), ports.end(), [](ivl_signal_t a, ivl_signal_t b) { return ivl_signal_module_port_index(a) < ivl_signal_module_port_index(b); });
		  for (ivl_signal_t sig : ports) cell.pins.push_back(Pin{ ivl_signal_basename(sig), ivl_signal_port(sig) == IVL_SIP_OUTPUT, bits_of(ivl_signal_nex(sig, 0)) });
		  cells.push_back(cell);
	    }
      }

      // Ports and named nets.
      std::vector<ivl_signal_t> port_sigs;
      std::string netnames;
      for (ivl_scope_t scope : body) {
	    for (unsigned idx = 0; idx < ivl_scope_sigs(scope); idx += 1) {
		  ivl_signal_t sig = ivl_scope_sig(scope, idx);
		  if (ivl_signal_array_count(sig) > 1 || ivl_signal_local(sig)) continue;
		  if (scope == module && ivl_signal_port(sig) != IVL_SIP_NONE) port_sigs.push_back(sig);
		  if (!netnames.empty()) netnames += ",";
		  netnames += quote(local_name(module, ivl_signal_name(sig))) + ":{\"hide_name\":0,\"bits\":" + bits_json(bits_of(ivl_signal_nex(sig, 0)))
			+ ",\"attributes\":{\"src\":" + quote(src_of(ivl_signal_file(sig), ivl_signal_lineno(sig))) + "}}";
	    }
      }
      std::stable_sort(port_sigs.begin(), port_sigs.end(), [](ivl_signal_t a, ivl_signal_t b) { return ivl_signal_module_port_index(a) < ivl_signal_module_port_index(b); });

      std::string out_text = quote(module_key(module)) + ":{\"attributes\":{";
      if (top) out_text += "\"top\":\"00000000000000000000000000000001\",";
      out_text += "\"src\":" + quote(src_of(ivl_scope_def_file(module), ivl_scope_def_lineno(module))) + "},\"ports\":{";
      for (size_t idx = 0; idx < port_sigs.size(); idx += 1) {
	    ivl_signal_port_t dir = ivl_signal_port(port_sigs[idx]);
	    out_text += (idx ? "," : "") + quote(ivl_signal_basename(port_sigs[idx])) + ":{\"direction\":"
		  + (dir == IVL_SIP_INPUT ? "\"input\"" : dir == IVL_SIP_OUTPUT ? "\"output\"" : "\"inout\"")
		  + ",\"bits\":" + bits_json(bits_of(ivl_signal_nex(port_sigs[idx], 0))) + "}";
      }
      out_text += "},\"cells\":{";
      for (size_t idx = 0; idx < cells.size(); idx += 1) out_text += (idx ? "," : "") + cell_json(cells[idx]);
      return out_text + "},\"netnames\":{" + netnames + "}}";
}

void module_scopes(ivl_scope_t scope, std::vector<ivl_scope_t>&out)
{
      if (is_module(scope)) out.push_back(scope);
      for (ivl_scope_t child : children(scope)) module_scopes(child, out);
}

/* Allocate bits for every signal first so ids follow declaration order. */
void touch_signals(ivl_scope_t scope)
{
      for (unsigned idx = 0; idx < ivl_scope_sigs(scope); idx += 1) {
	    ivl_signal_t sig = ivl_scope_sig(scope, idx);
	    for (unsigned word = 0; word < ivl_signal_array_count(sig) && word < 1; word += 1) bits_of(ivl_signal_nex(sig, word));
      }
      for (ivl_scope_t child : children(scope)) touch_signals(child);
}

} // namespace

extern "C" int target_design_json(ivl_design_t des)
{
      const char*path = ivl_design_flag(des, "-o");
      if (!path || !*path) { fprintf(stderr, "json.tgt: no output file\n"); return 1; }

      ivl_scope_t*roots = 0;
      unsigned nroots = 0;
      ivl_design_roots(des, &roots, &nroots);
      std::vector<ivl_scope_t> tops;
      for (unsigned idx = 0; idx < nroots; idx += 1) if (is_module(roots[idx])) tops.push_back(roots[idx]);

      for (ivl_scope_t top : tops) { touch_signals(top); count_types(top); }
      for (unsigned idx = 0; idx < ivl_design_consts(des); idx += 1) {
	    ivl_net_const_t con = ivl_design_const(des, idx);
	    if (ivl_const_type(con) == IVL_VT_REAL) continue;
	    const char*value = ivl_const_bits(con);
	    std::vector<int> bits = bits_of(ivl_const_nex(con));
	    for (size_t bit = 0; bit < bits.size() && bit < ivl_const_width(con); bit += 1) {
		  char ch = value[bit];
		  int root = find(bits[bit]);
		  constant[root] = ch == '1' ? '1' : ch == 'x' ? 'x' : ch == 'z' ? 'z' : '0';
	    }
      }
      for (ivl_scope_t top : tops) fold_scope(top);
      for (unsigned round = 0; round < 8; round += 1) {
	    unsigned folded = 0;
	    for (ivl_scope_t top : tops) folded += fold_constant_selects(top);
	    if (!folded) break;
      }
      ivl_design_process(des, collect_process, 0);

      std::string text = "{\"creator\":\"Icarus Verilog (Datapath Studio json.tgt)\",\"modules\":{";
      bool first = true;
      for (ivl_scope_t top : tops) {
	    std::vector<ivl_scope_t> scopes;
	    module_scopes(top, scopes);
	    for (ivl_scope_t scope : scopes) {
		  text += (first ? "" : ",") + emit_module(scope, scope == top);
		  first = false;
	    }
      }
      text += "}}\n";
      FILE*file = fopen(path, "w");
      if (!file) { perror(path); return 1; }
      bool ok = fwrite(text.data(), 1, text.size(), file) == text.size();
      return fclose(file) == 0 && ok ? 0 : 1;
}
