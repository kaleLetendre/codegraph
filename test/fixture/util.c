// Cross-file callee of a_main, and a leaf the trace should reach.

static int leaf(int x) {
  return x * 2;
}

int a_util(int x) {
  return leaf(x);
}
