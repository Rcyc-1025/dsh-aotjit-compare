// AOT/JIT 对拍夹具：case-07
// toy.add -> print 0，再 + 7 作为 exit code（7）。
module {
  func.func @main() -> i32 {
    %lhs = toy.constant 0 : i32
    %rhs = toy.constant 0 : i32
    %sum = toy.add %lhs, %rhs : i32
    toy.print %sum : i32
    %bias = toy.constant 7 : i32
    %ret = toy.add %sum, %bias : i32
    return %ret : i32
  }
}
