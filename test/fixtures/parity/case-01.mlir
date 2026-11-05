// AOT/JIT 对拍夹具：case-01
// toy.add -> print 7，再 + 2 作为 exit code（9）。
module {
  func.func @main() -> i32 {
    %lhs = toy.constant 3 : i32
    %rhs = toy.constant 4 : i32
    %sum = toy.add %lhs, %rhs : i32
    toy.print %sum : i32
    %bias = toy.constant 2 : i32
    %ret = toy.add %sum, %bias : i32
    return %ret : i32
  }
}
