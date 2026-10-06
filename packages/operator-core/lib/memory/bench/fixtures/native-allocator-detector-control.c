/* Confined WI-10005599 detector positive control, not an ORT reproduction.
 * Stable N-API keeps the 64-byte allocation inside the measured Node process.
 * The opt-in tail overwrite is intentional; no manual abort substitutes for
 * the allocator detecting it. Never load this fixture in a product process.
 */
#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

static napi_value detect(napi_env env, napi_callback_info info) {
  napi_value argument, result;
  size_t count = 1, length = 0;
  char fault[32];
  if (napi_get_cb_info(env, info, &count, &argument, NULL, NULL) != napi_ok || count != 1 ||
      napi_get_value_string_utf8(env, argument, fault, sizeof(fault), &length) != napi_ok ||
      (strcmp(fault, "clean") && strcmp(fault, "tail-overwrite"))) {
    napi_throw_type_error(env, NULL, "expected clean or tail-overwrite allocator control");
    return NULL;
  }
  struct rlimit core_limit = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core_limit) != 0) {
    napi_throw_error(env, NULL, "allocator control could not disable core dumps");
    return NULL;
  }
  const char core_marker[] = "PC_NATIVE_ALLOCATOR_CORE_LIMIT_ZERO\n";
  if (write(STDOUT_FILENO, core_marker, sizeof(core_marker) - 1) != sizeof(core_marker) - 1) {
    napi_throw_error(env, NULL, "short allocator core marker write");
    return NULL;
  }
  volatile unsigned char *allocation = malloc(64);
  if (!allocation) {
    napi_throw_error(env, NULL, "allocator control allocation failed");
    return NULL;
  }
  memset((void *)allocation, 0xa5, 64);
  if (!strcmp(fault, "tail-overwrite")) {
    /* glibc's checked allocator stores its tail marker at this boundary.
     * XOR guarantees a change regardless of the address-derived marker byte.
     */
    allocation[64] ^= 0xff;
    const char fault_marker[] = "PC_NATIVE_ALLOCATOR_TAIL_OVERWRITE\n";
    if (write(STDOUT_FILENO, fault_marker, sizeof(fault_marker) - 1) != sizeof(fault_marker) - 1) {
      napi_throw_error(env, NULL, "short allocator fault marker write");
      return NULL;
    }
  }
  const char free_marker[] = "PC_NATIVE_ALLOCATOR_BEFORE_FREE\n";
  if (write(STDOUT_FILENO, free_marker, sizeof(free_marker) - 1) != sizeof(free_marker) - 1) {
    napi_throw_error(env, NULL, "short allocator free marker write");
    return NULL;
  }
  free((void *)allocation);
  if (napi_get_boolean(env, true, &result) != napi_ok) return NULL;
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "detect", NAPI_AUTO_LENGTH, detect, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "detect", function) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(native_allocator_detector_control, initialize)
