// AOT/JIT 对拍夹具：case-03
// toy.add -> print 123，再 + 4 作为 exit code（127）。
module {
  func.func @main() -> i32 {
    %lhs = toy.constant 100 : i32
    %rhs = toy.constant 23 : i32
    %sum = toy.add %lhs, %rhs : i32
    toy.print %sum : i32
    %bias = toy.constant 4 : i32
    %ret = toy.add %sum, %bias : i32
    return %ret : i32
  }
}
