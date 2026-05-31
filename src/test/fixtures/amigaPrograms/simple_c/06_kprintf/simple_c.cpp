#include <proto/exec.h>
struct ExecBase* SysBase;

asm(
	".pushsection .text.KPutCharX,\"ax\",@progbits\n"
	".globl KPutCharX\n"
	"KPutCharX:\n"
	"    move.l  a6, -(sp)\n"
	"    move.l  4.w, a6\n"
	"    jsr     -0x204(a6)\n"
	"    move.l  (sp)+, a6\n"
	"    rts\n"
	".popsection"
);
extern "C" void KPutCharX();

typedef unsigned char *va_list;
#define va_start(ap, lastarg) ((ap)=(va_list)(&lastarg+1))

extern "C"
__attribute__((noinline)) __attribute__((optimize("O1")))
void KPrintF(const char* fmt, ...) {
	va_list vl;
	va_start(vl, fmt);
	RawDoFmt((CONST_STRPTR)fmt, vl, KPutCharX, 0);
}

extern "C"
__attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	SysBase = *((struct ExecBase**)4UL);
	KPrintF("Hallo, wie gehts?\n");
	while(1) {}
}
