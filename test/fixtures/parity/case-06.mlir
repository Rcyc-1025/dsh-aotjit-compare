// AOT/JIT 对拍夹具：case-06
// toy.add -> print 18，再 + 9 作为 exit code（27）。
module {
  func.func @main() -> i32 {
    %lhs = toy.constant 9 : i32
    %rhs = toy.constant 9 : i32
    %sum = toy.add %lhs, %rhs : i32
    toy.print %sum : i32
    %bias = toy.constant 9 : i32
    %ret = toy.add %sum, %bias : i32
    return %ret : i32
  }
}
