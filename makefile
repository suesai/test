CXX := g++
CXXFLAGS := -Wall -std=c++14 -g -fno-elide-constructors
CPPFLAGS := -Iinclude -MMD
LDFLAGS := -Llib -Wl,-rpath,/home/susai/project/c++/test/lib
LDLIBS := -lpthread
RM := rm -rf

BINDIR := bin
BINDBGDIR := bin/debug
BINRLSDIR := bin/release
BINTESTDIR := bin/test
BLDDIR := build
BLDDBGDIR := build/debug
BLDRLSDIR := build/release
BLDTESTDIR := build/test
SRCDIR := src
TESTDIR := test

TGTNAME := main
TESTNAME := test
DBGTGT := $(BINDBGDIR)/$(TGTNAME)
RLSTGT := $(BINRLSDIR)/$(TGTNAME)
TESTTGT := $(BINTESTDIR)/$(TESTNAME)

SRCEXT := cc
SOURCES := $(shell find $(SRCDIR) -type f -name *.$(SRCEXT))
TESTSRCS := $(shell find $(TESTDIR) -type f -name *.$(SRCEXT))
DBGOBJS := $(patsubst $(SRCDIR)/%,$(BLDDBGDIR)/%,$(SOURCES:.$(SRCEXT)=.o))
RLSOBJS := $(patsubst $(SRCDIR)/%,$(BLDRLSDIR)/%,$(SOURCES:.$(SRCEXT)=.o))
TESTOBJS := $(patsubst $(TESTDIR)/%,$(BLDTESTDIR)/%,$(TESTSRCS:.$(SRCEXT)=.o))
DBGDEPS := $(DBGOBJS:.o=.d)
RLSDEPS := $(RLSOBJS:.o=.d)
TESTDEPS := $(TESTOBJS:.o=.d)

-include $(DBGDEPS)
-include $(RLSDEPS)
-include $(TESTDEPS)

.PHONY : all
all : debug

.PHONY : debug
debug : CXXFLAGS += -UNDEBUG -Og
debug : $(DBGTGT)

$(DBGTGT) : $(DBGOBJS)
	@echo Link...
	@mkdir -p $(@D)
	$(CXX) -o $@ $^ $(LDFLAGS) $(LDLIBS)

$(BLDDBGDIR)/%.o : $(SRCDIR)/%.$(SRCEXT)
	@mkdir -p $(@D)
	$(CXX) -o $@ -c $< $(CXXFLAGS) $(CPPFLAGS)

.PHONY : release
release : CXXFLAGS += -DNDEBUG -O2
release : $(RLSTGT)

$(RLSTGT) : $(RLSOBJS)
	@echo Link...
	@mkdir -p $(@D)
	$(CXX) -o $@ $^ $(LDFLAGS) $(LDLIBS)

$(BLDRLSDIR)/%.o : $(SRCDIR)/%.$(SRCEXT)
	@mkdir -p $(@D)
	$(CXX) -o $@ -c $< $(CXXFLAGS) $(CPPFLAGS)

.PHONY : test
test : CXXFLAGS = -UNDEBUG -Og
$(TESTTGT) : $(TESTOBJS)
	@echo Link...
	@mkdir -p $(@D)
	$(CXX) -o $@ $^ $(LDFLAGS) $(LDLIBS)

$(BLDTESTDIR)/%.o : $(TESTDIR)/%.$(SRCEXT)
	@mkdir -p $(@D)
	$(CXX) -o $@ -c $< $(CXXFLAGS) $(CPPFLAGS)

.PHONY : clean
clean :
	@echo Cleaning...
	$(RM) $(BINDIR) $(BLDDIR)