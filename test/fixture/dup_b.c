// Second definition of dup() so find_symbol("dup") is ambiguous (2 matches).

int dup(int z) {
  return z + 100;
}
