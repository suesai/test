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
#include <vector>

#include "cout_int.h"
#include "usefuldef.h"


int main(int argc, char *argv[], char *env[])
{
  std::cout << "\nEnd\n";
  return EXIT_SUCCESS;
}
