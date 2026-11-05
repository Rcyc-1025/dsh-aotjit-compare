// AOT/JIT 对拍夹具：case-05
// toy.add -> print 100，再 + 1 作为 exit code（101）。
module {
  func.func @main() -> i32 {
    %lhs = toy.constant 50 : i32
    %rhs = toy.constant 50 : i32
    %sum = toy.add %lhs, %rhs : i32
    toy.print %sum : i32
    %bias = toy.constant 1 : i32
    %ret = toy.add %sum, %bias : i32
    return %ret : i32
  }
}
