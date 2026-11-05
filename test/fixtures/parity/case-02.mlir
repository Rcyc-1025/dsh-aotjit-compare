// AOT/JIT 对拍夹具：case-02
// toy.add -> print 30，再 + 5 作为 exit code（35）。
module {
  func.func @main() -> i32 {
    %lhs = toy.constant 10 : i32
    %rhs = toy.constant 20 : i32
    %sum = toy.add %lhs, %rhs : i32
    toy.print %sum : i32
    %bias = toy.constant 5 : i32
    %ret = toy.add %sum, %bias : i32
    return %ret : i32
  }
}
