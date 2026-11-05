// AOT/JIT 对拍夹具：case-04
// toy.add -> print 3，再 + 0 作为 exit code（3）。
module {
  func.func @main() -> i32 {
    %lhs = toy.constant 1 : i32
    %rhs = toy.constant 2 : i32
    %sum = toy.add %lhs, %rhs : i32
    toy.print %sum : i32
    %bias = toy.constant 0 : i32
    %ret = toy.add %sum, %bias : i32
    return %ret : i32
  }
}
