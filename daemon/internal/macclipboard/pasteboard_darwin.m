// Issue #215 phase 2: replace the reck-clipboard sidecar with a
// direct NSPasteboard write inside the daemon. Compiled by cgo
// alongside pasteboard_darwin.go (filename suffix `_darwin.m` is
// recognised + only built on darwin).
//
// Lock ordering: a single static NSLock serialises clear+set pairs
// across goroutines — clearContents followed by setData:forType:
// is logically a single atomic operation, but two interleaved
// pairs (clear A, clear B, set A, set B) would land as just
// "set B" with no payload. Cheap to lock; high volume is a
// non-issue for image paste.
//
// Memory safety: dataWithBytes:length: COPIES the buffer into
// AppKit-managed memory. Do NOT switch to dataWithBytesNoCopy —
// the caller's buffer is a Go slice backing array, and AppKit may
// retain the NSData past the cgo call boundary, dereferencing
// memory the Go GC has already moved or freed.

#import <AppKit/AppKit.h>
#include <stddef.h>

static NSLock *g_pb_lock = nil;

__attribute__((constructor))
static void reck_pb_init(void) {
    g_pb_lock = [[NSLock alloc] init];
}

int reck_set_pasteboard(const void *bytes, size_t n, const char *uti) {
    if (bytes == NULL || n == 0 || uti == NULL) {
        return -1;
    }
    @autoreleasepool {
        NSString *type = [NSString stringWithUTF8String:uti];
        if (type == nil) {
            return -1;
        }
        NSData *data = [NSData dataWithBytes:bytes length:n];
        if (data == nil) {
            return -1;
        }
        [g_pb_lock lock];
        NSPasteboard *pb = [NSPasteboard generalPasteboard];
        [pb clearContents];
        BOOL ok = [pb setData:data forType:type];
        [g_pb_lock unlock];
        return ok ? 0 : -1;
    }
}
