#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <iostream>
#include <memory>
#include <string>
#include <type_traits>

#include "ins_sort.h"
#include "qk_sort.h"
#include "stack.h"

#include "cout_int.h"
#include "usefuldef.h"


class Foo
{
 public:
  Foo() noexcept { COUT_FUNC_SIGNATURE; }
  Foo(int a) noexcept : a_{a} { COUT_FUNC_SIGNATURE; }
  ~Foo() noexcept { a_ = 0; COUT_FUNC_SIGNATURE; }
  Foo(const Foo& f) noexcept : a_{f.a_} { COUT_FUNC_SIGNATURE; }
  Foo(Foo&& f) noexcept : a_{f.a_} { f.a_ = 0; COUT_FUNC_SIGNATURE; }
  Foo& operator=(const Foo& f) noexcept { this->a_ = f.a_; COUT_FUNC_SIGNATURE; return *this; }
  Foo& operator=(Foo&& f) noexcept { this->a_ = f.a_; f.a_ = 0; COUT_FUNC_SIGNATURE; return *this; }

  int getA() const noexcept { return a_; }
  void setA(int a) noexcept { a_ = a; }

 private:
  int a_{};
};


template <typename Tp_>
class Try
{
 public:
  using Type = Tp_;
};


template <typename Tp1_, typename Tp2_ = Try<Tp1_>>
class The
{
 public:
  using Type = Tp2_;
};


template <typename Tp1_, typename Tp2_>
class The<Tp1_[], Tp2_>
{
 public:
  using Type = Tp2_;
};


class Foo1
{
 public:
  void Func() const noexcept {
    auto lambda = [i = this->i_]() noexcept {
      COUT_FUNC_SIGNATURE;
      std::cout << i << '\n';
    };
    lambda();
  };

 private:
  int i_{20};
};


void Func(auto&& f) noexcept
{
  std::cout << std::boolalpha
            << std::is_same<decltype(f), Foo1&&>::value << '\n';
}


int main(int argc, char *argv[], char *env[])
{
  // Func(Foo1{});
  // Foo1 f;
  // Func(f);
  std::cout << "just for test!\n";

  std::cout << "\nEnd\n";
  return EXIT_SUCCESS;
}
